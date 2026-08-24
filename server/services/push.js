// Web Push notifications (VAPID) — works from any browser, no app store
// build and no per-message cost, unlike SMS/FCM. A student "subscribes"
// once from the course page; from then on their browser can receive a
// notification even when the tab is closed, via the service worker
// (public/sw.js).

const webpush = require("web-push");
const db = require("../db");

function isConfigured() {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

function configure() {
  if (!isConfigured()) return;
  webpush.setVapidDetails(
    process.env.VAPID_CONTACT_EMAIL || "mailto:admin@example.com",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}
configure();

function saveSubscription(studentId, subscription) {
  const { endpoint, keys } = subscription;
  db.prepare(
    `INSERT INTO push_subscriptions (student_id, endpoint, p256dh, auth)
     VALUES (?,?,?,?)
     ON CONFLICT(endpoint) DO UPDATE SET student_id = excluded.student_id`
  ).run(studentId, endpoint, keys.p256dh, keys.auth);
}

// Resolves which students should be notified for a live class:
//   enrolled_only -> just the course's registered students
//   open_to_all   -> registered students PLUS every other subscribed
//                    student (acts as the "non-registered / everyone" reach)
function subscriptionsFor(courseId, accessType) {
  if (accessType === "enrolled_only") {
    return db
      .prepare(
        `SELECT ps.* FROM push_subscriptions ps
         JOIN enrollments e ON e.student_id = ps.student_id
         WHERE e.course_id = ?`
      )
      .all(courseId);
  }
  return db.prepare(`SELECT * FROM push_subscriptions`).all();
}

// Shared sender behind all three notification kinds below — same audience
// resolution, same expired-subscription cleanup, same logging, just a
// different title/body and a `kind` tag in notification_log so it's clear
// afterwards which of the three actually went out.
async function sendToAudience(liveClass, kind, { title, body }) {
  if (!isConfigured()) {
    console.warn("[push] VAPID keys not set — skipping push, see .env.example");
    return 0;
  }
  const subs = subscriptionsFor(liveClass.course_id, liveClass.access_type);
  const payload = JSON.stringify({ title, body, url: `/watch.html?live=${liveClass.id}` });

  let sent = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
      sent++;
    } catch (err) {
      // Gone/expired subscription — clean it up so future sends don't retry it.
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(sub.endpoint);
      } else {
        console.error("[push] send failed:", err.message);
      }
    }
  }

  db.prepare(
    "INSERT INTO notification_log (live_class_id, recipient_count, kind) VALUES (?,?,?)"
  ).run(liveClass.id, sent, kind);

  return sent;
}

// The audience is India-based (NEET/JEE, UP TGT/PGT) so the scheduled time
// is spelled out in IST in the notification text itself — a push payload
// is plain text with no per-recipient formatting, so a timezone has to be
// picked up front rather than left to each device.
function formatIST(isoString) {
  try {
    return (
      new Date(isoString).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }) + " IST"
    );
  } catch {
    return null;
  }
}

// Fired once, right when a teacher schedules a class (POST .../live-classes).
async function notifyLiveClassScheduled(liveClass) {
  const when = liveClass.scheduled_at ? formatIST(liveClass.scheduled_at) : null;
  return sendToAudience(liveClass, "scheduled", {
    title: "🗓️ New class scheduled",
    body: when ? `${liveClass.title} — ${when}` : `${liveClass.title} — check the app for timing`,
  });
}

// Fired once, automatically, 5 minutes before scheduled_at — see
// checkReminders() in services/youtubeSync.js.
async function notifyLiveClassReminder(liveClass) {
  return sendToAudience(liveClass, "reminder", {
    title: "⏰ Starting in 5 minutes",
    body: liveClass.title,
  });
}

// Fired once YouTube's own broadcast lifecycle actually flips to "live"
// (services/youtubeSync.js polling) — the moment the teacher's stream
// really starts, not when it was scheduled to.
async function notifyLiveClassStarted(liveClass) {
  return sendToAudience(liveClass, "live", {
    title: "🔴 Live now",
    body: liveClass.title,
  });
}

// Generic "send this to one student's devices" — used outside the
// live-class flow (abandoned-cart reminders, etc.) so it doesn't touch
// notification_log (that table is live_class-specific by design; see
// services/cartReminders.js for its own audit trail).
async function sendToStudent(studentId, { title, body, url }) {
  if (!isConfigured()) return 0;
  const subs = db.prepare("SELECT * FROM push_subscriptions WHERE student_id = ?").all(studentId);
  const payload = JSON.stringify({ title, body, url: url || "/" });
  let sent = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(sub.endpoint);
      } else {
        console.error("[push] send failed:", err.message);
      }
    }
  }
  return sent;
}

module.exports = {
  isConfigured,
  saveSubscription,
  notifyLiveClassScheduled,
  notifyLiveClassReminder,
  notifyLiveClassStarted,
  sendToStudent,
};
