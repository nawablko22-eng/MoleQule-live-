// The one place that actually "completes" a purchase — shared by the
// client-driven checkout verify route AND the Razorpay webhook, so
// whichever one hears about a successful payment first does the same
// thing, and if both fire (normal — that's the point of having both) the
// second call is a safe no-op.

const db = require("../db");

function completeOrder(orderId, studentId, paymentRef) {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
  if (!order || order.status === "paid") return; // already done — idempotent

  const items = db.prepare("SELECT * FROM order_items WHERE order_id = ?").all(orderId);
  // expires_at is computed from the course's validity_days AT THIS MOMENT
  // (frozen from here on, like item.price already is) -- ON CONFLICT ...
  // DO UPDATE instead of INSERT OR IGNORE so re-buying a course whose
  // access already ran out actually renews it, rather than silently doing
  // nothing because the old (expired) enrollment row is still there.
  const enroll = db.prepare(
    `INSERT INTO enrollments (course_id, student_id, expires_at)
       SELECT c.id, ?, CASE WHEN c.validity_days IS NULL THEN NULL ELSE datetime('now', '+' || c.validity_days || ' days') END
       FROM courses c WHERE c.id = ?
     ON CONFLICT(course_id, student_id) DO UPDATE SET enrolled_at = datetime('now'), expires_at = excluded.expires_at`
  );
  for (const item of items) enroll.run(studentId, item.course_id);

  db.prepare(
    "UPDATE orders SET status = 'paid', payment_ref = ?, paid_at = datetime('now') WHERE id = ?"
  ).run(paymentRef, orderId);

  // The coupon (if any) was already validated when the order was created
  // (see routes/cart.js checkout) — this just books the redemption now
  // that payment is actually confirmed, so an abandoned/failed order never
  // burns a single-use code.
  if (order.coupon_code) {
    db.prepare("UPDATE coupons SET used_count = used_count + 1 WHERE code = ?").run(order.coupon_code);
  }

  // Only clear the courses that were actually just bought — the student
  // may have added something else to the cart in the meantime.
  const courseIds = items.map((i) => i.course_id);
  if (courseIds.length) {
    const placeholders = courseIds.map(() => "?").join(",");
    db.prepare(
      `DELETE FROM cart_items WHERE student_id = ? AND course_id IN (${placeholders})`
    ).run(studentId, ...courseIds);
  }
}

module.exports = { completeOrder };
