const express = require("express");
const { requireRole } = require("../middleware/auth");
const push = require("../services/push");

const router = express.Router();

router.get("/public-key", (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || null, configured: push.isConfigured() });
});

// POST /api/push/subscribe (student) { subscription: PushSubscriptionJSON }
router.post("/subscribe", requireRole("student"), (req, res) => {
  const { subscription } = req.body;
  if (!subscription?.endpoint || !subscription?.keys) {
    return res.status(400).json({ error: "Invalid push subscription payload." });
  }
  push.saveSubscription(req.user.id, subscription);
  res.json({ ok: true });
});

module.exports = router;
