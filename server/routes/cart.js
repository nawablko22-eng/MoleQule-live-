// Blinkit-style shopping cart for paid courses: browse -> Add to Cart ->
// Cart -> Pay. Free courses (price = 0) skip all of this and enroll
// directly via POST /api/courses/:id/enroll — see routes/courses.js.

const express = require("express");
const db = require("../db");
const { requireRole } = require("../middleware/auth");
const payments = require("../services/payments");
const { completeOrder } = require("../services/orders");
const { checkCoupon } = require("./coupons");
const access = require("../services/access");

const router = express.Router();

// GET /api/cart — the student's current cart, with a running total.
router.get("/cart", requireRole("student"), (req, res) => {
  const items = db
    .prepare(
      `SELECT ci.id AS cart_item_id, c.id AS course_id, c.title, c.description, c.price
       FROM cart_items ci JOIN courses c ON c.id = ci.course_id
       WHERE ci.student_id = ? ORDER BY ci.added_at DESC`
    )
    .all(req.user.id);
  const total = items.reduce((sum, i) => sum + i.price, 0);
  res.json({ items, total, count: items.length });
});

// POST /api/cart  { course_id } — add a paid course to the cart.
router.post("/cart", requireRole("student"), (req, res) => {
  const course = db.prepare("SELECT * FROM courses WHERE id = ?").get(req.body.course_id);
  if (!course) return res.status(404).json({ error: "Course not found." });
  if (course.price <= 0) {
    return res.status(400).json({ error: "This course is free — register directly instead of adding it to the cart." });
  }
  // Only an ACTIVE registration blocks re-adding to cart -- an expired one
  // (see courses.validity_days) should still be re-purchasable, since
  // that's exactly how a student renews a paid course (services/orders.js
  // completeOrder extends expires_at on repurchase instead of no-op'ing).
  if (access.isEnrolled(course.id, req.user.id)) {
    return res.status(409).json({ error: "You're already registered for this course." });
  }

  db.prepare("INSERT OR IGNORE INTO cart_items (student_id, course_id) VALUES (?,?)").run(req.user.id, course.id);
  res.json({ ok: true });
});

// DELETE /api/cart/:courseId — remove one course from the cart.
router.delete("/cart/:courseId", requireRole("student"), (req, res) => {
  db.prepare("DELETE FROM cart_items WHERE student_id = ? AND course_id = ?").run(req.user.id, req.params.courseId);
  res.json({ ok: true });
});

// POST /api/checkout  { coupon_code? } — turns the whole cart into one
// order, applying a coupon (server-side, re-validated here — never trust
// a discount the client just claims) if one was passed.
//   - No Razorpay keys set (demo mode): the order is completed instantly
//     for free, so you can see and test the entire flow right now.
//   - Razorpay configured: creates a real Razorpay order (for the
//     DISCOUNTED amount) and hands back what the browser needs to open
//     Razorpay's own Checkout widget; the purchase only completes once
//     /api/checkout/verify (or the webhook) confirms a real payment.
router.post("/checkout", requireRole("student"), async (req, res) => {
  const items = db
    .prepare(
      `SELECT ci.*, c.title, c.price FROM cart_items ci
       JOIN courses c ON c.id = ci.course_id WHERE ci.student_id = ?`
    )
    .all(req.user.id);
  if (!items.length) return res.status(400).json({ error: "Your cart is empty." });
  const subtotal = items.reduce((sum, i) => sum + i.price, 0);

  let couponCode = null;
  let discountAmount = 0;
  if (req.body.coupon_code) {
    const result = checkCoupon(req.body.coupon_code, req.user.id);
    if (!result.ok) return res.status(400).json({ error: result.error });
    couponCode = result.coupon.code;
    discountAmount = Math.round((subtotal * result.coupon.discount_percent) / 100);
  }
  const total = Math.max(0, subtotal - discountAmount);

  const orderInfo = db
    .prepare(
      `INSERT INTO orders (student_id, total_amount, status, payment_provider, coupon_code, discount_amount)
       VALUES (?,?, 'pending', ?, ?, ?)`
    )
    .run(req.user.id, total, payments.isConfigured() ? "razorpay" : "demo", couponCode, discountAmount);
  const orderId = orderInfo.lastInsertRowid;
  const insertItem = db.prepare("INSERT INTO order_items (order_id, course_id, price) VALUES (?,?,?)");
  for (const item of items) insertItem.run(orderId, item.course_id, item.price);

  if (!payments.isConfigured()) {
    completeOrder(orderId, req.user.id, "demo-" + orderId);
    return res.json({
      mode: "demo",
      order_id: orderId,
      total,
      discount_amount: discountAmount,
      message:
        "No payment gateway is connected yet (see README), so this checkout completed as a free demo — you're enrolled in everything that was in the cart.",
    });
  }

  if (total === 0) {
    // A 100%-off coupon fully covered it — nothing to actually charge, so
    // there's no reason to open the Razorpay widget for ₹0.
    completeOrder(orderId, req.user.id, "coupon-" + orderId);
    return res.json({
      mode: "demo",
      order_id: orderId,
      total,
      discount_amount: discountAmount,
      message: "Your coupon covered the full amount — you're enrolled, nothing to pay.",
    });
  }

  try {
    const rpOrder = await payments.createOrder(total, `order_${orderId}`);
    db.prepare("UPDATE orders SET payment_order_id = ? WHERE id = ?").run(rpOrder.id, orderId);
    res.json({
      mode: "razorpay",
      order_id: orderId,
      razorpay_key_id: process.env.RAZORPAY_KEY_ID,
      razorpay_order_id: rpOrder.id,
      amount: rpOrder.amount,
      currency: rpOrder.currency,
      discount_amount: discountAmount,
    });
  } catch (err) {
    db.prepare("UPDATE orders SET status = 'failed' WHERE id = ?").run(orderId);
    res.status(502).json({ error: "Could not start payment: " + err.message });
  }
});

// POST /api/checkout/verify — called by the browser right after Razorpay
// Checkout.js reports success. Confirms the signature is genuine before
// enrolling anyone (see services/payments.js). The webhook (if you've set
// one up) does the same thing independently, so a browser tab closing
// right after payment doesn't leave the student unenrolled — see README.
router.post("/checkout/verify", requireRole("student"), (req, res) => {
  const { order_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  const order = db.prepare("SELECT * FROM orders WHERE id = ? AND student_id = ?").get(order_id, req.user.id);
  if (!order) return res.status(404).json({ error: "Order not found." });

  const valid = payments.verifyCheckoutSignature({
    orderId: razorpay_order_id,
    paymentId: razorpay_payment_id,
    signature: razorpay_signature,
  });
  if (!valid) {
    db.prepare("UPDATE orders SET status = 'failed' WHERE id = ?").run(order.id);
    return res.status(400).json({ error: "Payment could not be verified." });
  }

  completeOrder(order.id, req.user.id, razorpay_payment_id);
  res.json({ ok: true });
});

module.exports = router;
