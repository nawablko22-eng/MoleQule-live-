// "Your cart is waiting" nudge — a student who added a paid course to
// their cart and never checked out gets reminded once, not spammed.
// Push works reliably with zero extra setup (same VAPID keys as live
// class notifications). WhatsApp is sent too when configured, best-effort
// — note Meta only allows a business-initiated WhatsApp message like this
// one outside the 24-hour reply window if it uses a pre-approved message
// TEMPLATE (see README); without one, this send will typically fail for
// a student who hasn't messaged the bot recently, which is why it's
// wrapped in try/catch and never blocks the push notification either way.

const db = require("../db");
const push = require("./push");
const whatsapp = require("./whatsapp");

const POLL_MS = 60 * 60 * 1000; // once an hour is plenty for a daily-scale nudge
const STALE_AFTER_MS = 24 * 60 * 60 * 1000; // cart untouched for 24h
const COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000; // don't remind the same student more than once per 3 days

function studentsWithStaleCarts() {
  return db
    .prepare(
      `SELECT u.id, u.name, u.phone,
         COUNT(ci.id) AS item_count,
         SUM(c.price) AS total,
         MAX(ci.added_at) AS newest_item_at
       FROM cart_items ci
       JOIN users u ON u.id = ci.student_id
       JOIN courses c ON c.id = ci.course_id
       GROUP BY u.id
       HAVING newest_item_at <= datetime('now', '-1 day')`
    )
    .all();
}

async function checkAbandonedCarts() {
  const candidates = studentsWithStaleCarts();
  for (const student of candidates) {
    const newestMs = Date.parse(student.newest_item_at.replace(" ", "T") + "Z"); // SQLite's datetime('now') format -> a real ISO string
    if (Number.isNaN(newestMs) || Date.now() - newestMs < STALE_AFTER_MS) continue;

    const lastReminder = db.prepare("SELECT sent_at FROM cart_reminders WHERE student_id = ?").get(student.id);
    if (lastReminder) {
      const lastMs = Date.parse(lastReminder.sent_at.replace(" ", "T") + "Z");
      if (!Number.isNaN(lastMs) && Date.now() - lastMs < COOLDOWN_MS) continue;
    }

    const title = "🛒 Your cart is waiting";
    const body = `${student.item_count} course${student.item_count === 1 ? "" : "s"} in your cart, ₹${student.total} total — finish checkout whenever you're ready.`;

    let pushSent = 0;
    try {
      pushSent = await push.sendToStudent(student.id, { title, body, url: "/cart.html" });
    } catch (err) {
      console.error(`[cartReminders] push failed for student ${student.id}:`, err.message);
    }

    if (whatsapp.isConfigured() && student.phone) {
      try {
        await whatsapp.sendMessage(student.phone, `${title}\n${body}`);
      } catch (err) {
        console.error(`[cartReminders] WhatsApp failed for student ${student.id} (expected outside the 24h window without an approved template):`, err.message);
      }
    }

    db.prepare(
      `INSERT INTO cart_reminders (student_id, sent_at) VALUES (?, datetime('now'))
       ON CONFLICT(student_id) DO UPDATE SET sent_at = excluded.sent_at`
    ).run(student.id);
    console.log(`[cartReminders] nudged student ${student.id} (${pushSent} push device(s))`);
  }
}

function start() {
  setInterval(() => {
    checkAbandonedCarts().catch((err) => console.error("[cartReminders] poll error:", err));
  }, POLL_MS);
}

module.exports = { start, checkAbandonedCarts };
