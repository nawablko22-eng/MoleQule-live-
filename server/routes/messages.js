// Unified admin inbox: one chat box for both Telegram and WhatsApp
// conversations, so the teacher never has to leave this dashboard to
// reply to a student on either app (see services/telegram.js and
// services/whatsapp.js for how messages get in here in the first place).

const express = require("express");
const db = require("../db");
const { requireRole } = require("../middleware/auth");
const telegram = require("../services/telegram");
const whatsapp = require("../services/whatsapp");

const router = express.Router();

// GET /api/conversations — thread list, newest activity first.
router.get("/conversations", requireRole("teacher"), (req, res) => {
  const conversations = db
    .prepare(
      `SELECT c.*, u.name AS student_name,
        (SELECT body FROM messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_message
       FROM conversations c LEFT JOIN users u ON u.id = c.student_id
       ORDER BY c.last_message_at DESC`
    )
    .all();
  res.json({ conversations, channels_configured: { telegram: telegram.isConfigured(), whatsapp: whatsapp.isConfigured() } });
});

// GET /api/conversations/:id/messages — full thread, oldest first.
router.get("/conversations/:id/messages", requireRole("teacher"), (req, res) => {
  const conversation = db.prepare("SELECT * FROM conversations WHERE id = ?").get(req.params.id);
  if (!conversation) return res.status(404).json({ error: "Conversation not found." });
  const messages = db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC").all(conversation.id);
  res.json({ conversation, messages });
});

// POST /api/conversations/:id/reply  { text } — sends via whichever
// channel this conversation is on, then saves it as an 'out' message.
router.post("/conversations/:id/reply", requireRole("teacher"), async (req, res) => {
  const conversation = db.prepare("SELECT * FROM conversations WHERE id = ?").get(req.params.id);
  if (!conversation) return res.status(404).json({ error: "Conversation not found." });
  const text = String(req.body.text || "").trim();
  if (!text) return res.status(400).json({ error: "Message can't be empty." });

  try {
    if (conversation.channel === "telegram") {
      await telegram.sendMessage(conversation.external_chat_id, text);
    } else {
      await whatsapp.sendMessage(conversation.external_chat_id, text);
    }
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  db.prepare("INSERT INTO messages (conversation_id, direction, body, sent_by) VALUES (?, 'out', ?, ?)")
    .run(conversation.id, text, req.user.id);
  db.prepare("UPDATE conversations SET last_message_at = datetime('now') WHERE id = ?").run(conversation.id);
  res.json({ ok: true });
});

module.exports = router;
