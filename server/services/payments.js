// Optional Razorpay integration — the "Pay" step of the Blinkit-style
// cart. Same isConfigured() pattern as YouTube/VAPID elsewhere in this
// app: without keys, checkout still works end-to-end in "demo" mode (see
// routes/cart.js) so you can see and test the whole flow right now; add
// real keys and it upgrades to actually collecting payment, no other code
// changes needed.

const crypto = require("crypto");

let Razorpay;
try {
  Razorpay = require("razorpay");
} catch {
  // Not installed — fine, demo mode doesn't need it. `npm install razorpay`
  // (already in package.json) picks it up once you're ready to go live.
}

function isConfigured() {
  return Boolean(Razorpay && process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

function client() {
  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

// amountRupees -> a Razorpay order (Razorpay wants the amount in paise).
async function createOrder(amountRupees, receipt) {
  const rp = client();
  return rp.orders.create({
    amount: Math.round(amountRupees * 100),
    currency: "INR",
    receipt,
  });
}

// Confirms a client-side Razorpay Checkout.js success callback is genuine
// (not just a browser claiming success) — HMAC-SHA256 of
// "order_id|payment_id" using your key secret, per Razorpay's docs.
function verifyCheckoutSignature({ orderId, paymentId, signature }) {
  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  return expected === signature;
}

// Confirms a server-to-server webhook body is genuinely from Razorpay —
// a DIFFERENT secret than the API key (the "webhook secret" you set when
// adding the webhook in the Razorpay dashboard). Optional defense-in-depth
// — see README section on the cart/checkout flow for why it matters.
function verifyWebhookSignature(rawBody, signature) {
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) return false;
  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
  return expected === signature;
}

module.exports = { isConfigured, createOrder, verifyCheckoutSignature, verifyWebhookSignature };
