// Meta calls this to (1) verify the endpoint once when you first paste the
// URL into the WhatsApp app's webhook settings, and (2) POST every inbound
// message afterwards. See README for the exact dashboard steps.

const express = require("express");
const whatsapp = require("../services/whatsapp");

const router = express.Router();

// GET /api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
router.get("/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token && process.env.WHATSAPP_VERIFY_TOKEN && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// POST /api/webhooks/whatsapp — inbound messages. Always 200s quickly (Meta
// retries aggressively on non-2xx), and does nothing if WhatsApp isn't
// actually configured yet (a stray request shouldn't ever be able to crash this).
router.post("/whatsapp", (req, res) => {
  res.sendStatus(200);
  if (!whatsapp.isConfigured()) return;
  try {
    whatsapp.handleWebhookPayload(req.body);
  } catch (err) {
    console.error("[whatsapp webhook] failed to process payload:", err.message);
  }
});

module.exports = router;
