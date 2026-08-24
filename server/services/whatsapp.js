// WhatsApp Cloud API (Meta) — sends/receives messages for the unified
// inbox. Unlike Telegram, this needs real setup on Meta's side before it
// can go live: a WhatsApp Business Account, a phone number registered to
// it, and a permanent access token (Meta for Developers -> your app ->
// WhatsApp -> API Setup). See README for the exact steps. Until then,
// isConfigured() is false and sending just fails with a clear message —
// same pattern as every other external dependency here.
//
// One extra wrinkle specific to WhatsApp: Meta only lets a business send
// a free-form reply within 24 hours of the customer's last message — a
// business-initiated message outside that window needs a pre-approved
// "template" message. This app only ever replies to something a student
// already sent (see routes/messages.js), so it stays inside that 24-hour
// customer-service window and never needs template approval.

const db = require("../db");

const GRAPH_VERSION = "v20.0";

function isConfigured() {
  return Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

async function sendMessage(to, text) {
  if (!isConfigured()) throw new Error("WhatsApp isn't connected — see .env.example (WHATSAPP_TOKEN/WHATSAPP_PHONE_NUMBER_ID).");
  const res = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error("WhatsApp: " + (data.error?.message || "send failed"));
  return data;
}

// Same shape as telegram.js's upsertConversation/recordInbound, so
// routes/messages.js can treat both channels identically. A WhatsApp
// conversation is matched to a student automatically, by phone number —
// no deep-link step needed like Telegram.
function upsertConversation({ externalChatId, displayName }) {
  const student = db.prepare("SELECT id FROM users WHERE phone = ?").get(externalChatId);
  const existing = db.prepare("SELECT * FROM conversations WHERE channel = 'whatsapp' AND external_chat_id = ?").get(externalChatId);
  if (existing) {
    db.prepare("UPDATE conversations SET last_message_at = datetime('now'), display_name = COALESCE(?, display_name), student_id = COALESCE(?, student_id) WHERE id = ?")
      .run(displayName || null, student?.id || null, existing.id);
    return existing.id;
  }
  const info = db
    .prepare("INSERT INTO conversations (channel, external_chat_id, student_id, display_name) VALUES ('whatsapp', ?, ?, ?)")
    .run(externalChatId, student?.id || null, displayName || null);
  return info.lastInsertRowid;
}

function recordInbound(conversationId, body) {
  db.prepare("INSERT INTO messages (conversation_id, direction, body) VALUES (?, 'in', ?)").run(conversationId, body);
}

// Parses one webhook POST body (see routes/whatsappWebhook.js) and saves
// every text message it contains. Meta batches multiple entries/changes
// per request, so this can add more than one message per call.
function handleWebhookPayload(payload) {
  const entries = payload?.entry || [];
  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const contact = (value.contacts || [])[0];
      for (const msg of value.messages || []) {
        if (msg.type !== "text") continue; // images/audio/etc. skipped for now
        const conversationId = upsertConversation({
          externalChatId: msg.from,
          displayName: contact?.profile?.name || null,
        });
        recordInbound(conversationId, msg.text.body);
      }
    }
  }
}

module.exports = { isConfigured, sendMessage, handleWebhookPayload, upsertConversation, recordInbound };
