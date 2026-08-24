// Optional server-to-server safety net for the Razorpay flow: if a
// student's browser closes right after paying but before the client-side
// /api/checkout/verify call finishes, the order would otherwise be stuck
// 'pending' forever even though Razorpay was actually paid. Setting up
// this webhook (see README) means Razorpay tells the server directly, so
// the purchase still completes.
//
// Needs the RAW request body to check the signature, so this router is
// mounted in index.js BEFORE express.json() — by the time a global JSON
// parser has run, the raw bytes needed for the HMAC check are gone.

const express = require("express");
const db = require("../db");
const payments = require("../services/payments");
const { completeOrder } = require("../services/orders");

const router = express.Router();

router.post("/razorpay", express.raw({ type: "application/json" }), (req, res) => {
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
    // Not set up — nothing to verify against. Not an error: the webhook
    // is optional, checkout still works fully without it (see README).
    return res.status(503).json({ error: "Webhook secret not configured." });
  }

  const signature = req.headers["x-razorpay-signature"];
  const valid = signature && payments.verifyWebhookSignature(req.body, signature);
  if (!valid) return res.status(400).json({ error: "Invalid webhook signature." });

  let event;
  try {
    event = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Malformed webhook body." });
  }

  if (event.event === "payment.captured" || event.event === "order.paid") {
    const rpOrderId = event.payload?.payment?.entity?.order_id || event.payload?.order?.entity?.id;
    const paymentId = event.payload?.payment?.entity?.id || "webhook";
    const order = db.prepare("SELECT * FROM orders WHERE payment_order_id = ?").get(rpOrderId);
    if (order) completeOrder(order.id, order.student_id, paymentId);
  }

  res.json({ ok: true });
});

module.exports = router;
