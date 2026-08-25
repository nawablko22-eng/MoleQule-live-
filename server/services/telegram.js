// Telegram bot — the easy half of the unified inbox: unlike WhatsApp,
// there's no business verification or template approval, just a bot token
// from @BotFather (message it "/newbot", copy the token it gives you into
// .env). Uses long-polling (getUpdates) instead of a webhook, so it works
// even without a public HTTPS URL — same isConfigured() pattern as every
// other external dependency in this app.

const db = require("../db");

const API_BASE = "https://api.telegram.org/bot";
let pollingStarted = false;
let offset = 0;

function isConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN);
}

function apiUrl(method) {
  return `${API_BASE}${process.env.TELEGRAM_BOT_TOKEN}/${method}`;
}

async function sendMessage(chatId, text) {
  if (!isConfigured()) throw new Error("Telegram isn't connected — see .env.example (TELEGRAM_BOT_TOKEN).");
  const res = await fetch(apiUrl("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error("Telegram: " + (data.description || "send failed"));
  return data.result;
}

// Finds (or creates) the conversation row for this Telegram chat, bumps
// its last_message_at, and appends the message. Shared shape with
// whatsapp.js's recordInbound() so routes/messages.js can treat both
// channels identically.
function upsertConversation({ channel, externalChatId, displayName, studentId }) {
  const existing = db.prepare("SELECT * FROM conversations WHERE channel = ? AND external_chat_id = ?").get(channel, externalChatId);
  if (existing) {
    db.prepare("UPDATE conversations SET last_message_at = datetime('now'), display_name = COALESCE(?, display_name), student_id = COALESCE(?, student_id) WHERE id = ?")
      .run(displayName || null, studentId || null, existing.id);
    return existing.id;
  }
  const info = db
    .prepare("INSERT INTO conversations (channel, external_chat_id, student_id, display_name) VALUES (?,?,?,?)")
    .run(channel, externalChatId, studentId || null, displayName || null);
  return info.lastInsertRowid;
}

function recordInbound(conversationId, body) {
  db.prepare("INSERT INTO messages (conversation_id, direction, body) VALUES (?, 'in', ?)").run(conversationId, body);
}

// A student's profile page can show a "Chat on Telegram" link that's really
// https://t.me/<bot username>?start=<student_id> — Telegram sends that
// student_id straight back to us as the /start command's payload the
// moment they open the bot, so we can link the conversation to their
// account with zero extra steps on their end.
async function handleUpdate(update) {
  const msg = update.message;
  if (!msg || !msg.chat) return;
  const chatId = String(msg.chat.id);
  const displayName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || msg.from?.username || "Telegram user";

  let studentId = null;
  const text = msg.text || "";
  if (text.startsWith("/start")) {
    const payload = text.split(" ")[1];
    if (payload && /^\d+$/.test(payload)) {
      const student = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'student'").get(Number(payload));
      if (student) studentId = student.id;
    }
    const conversationId = upsertConversation({ channel: "telegram", externalChatId: chatId, displayName, studentId });
    recordInbound(conversationId, "(started the bot)");
    try {
      await sendMessage(chatId, studentId
        ? "Linked to your MoleQule Live account — message here any time and YK Sir's team will reply."
        : "Welcome! Message here any time and YK Sir's team will reply. Open this link from your logged-in course page to link this chat to your account.");
    } catch { /* best-effort — DB record already saved either way */ }
    return;
  }

  if (!text) return; // ignore non-text messages (stickers, photos) for now
  const conversationId = upsertConversation({ channel: "telegram", externalChatId: chatId, displayName, studentId });
  recordInbound(conversationId, text);
}

async function poll() {
  try {
    const res = await fetch(apiUrl("getUpdates") + `?timeout=25&offset=${offset}`);
    const data = await res.json();
    if (data.ok) {
      for (const update of data.result) {
        offset = update.update_id + 1;
        await handleUpdate(update).catch((err) => console.error("[telegram] update handling failed:", err.message));
      }
    }
  } catch (err) {
    console.error("[telegram] poll failed:", err.message);
    await new Promise((r) => setTimeout(r, 5000)); // back off before retrying on a network hiccup
  }
  setImmediate(poll);
}

function startPolling() {
  if (!isConfigured() || pollingStarted) return;
  pollingStarted = true;
  console.log("[telegram] bot connected — polling for messages.");
  poll();
}

module.exports = { isConfigured, sendMessage, startPolling, upsertConversation, recordInbound };
