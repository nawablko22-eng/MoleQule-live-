// The background heartbeat of the whole "class -> auto-uploaded video"
// flow. Every few seconds it:
//
//  0. Checks every 'scheduled' class with a scheduled_at time and fires
//     the automatic "starting in 5 minutes" reminder once it's due (see
//     checkReminders() below). This step alone doesn't need YouTube at
//     all — it runs every poll regardless of Google config.
//
//  1. Looks at live_classes that are 'scheduled' with a bound YouTube
//     broadcast, and checks whether YouTube's own lifecycle status has
//     flipped to "live" (this happens the moment the teacher's encoder
//     starts pushing to the stream key, because we set
//     enableAutoStart/enableAutoStop when creating the broadcast).
//     The instant we see that flip, we mark it live in our DB and fire
//     the push notification — this is the "students get a notification
//     the moment I go live" requirement.
//
//  2. Looks at live_classes that are 'live' and checks whether YouTube
//     has since auto-stopped/archived the broadcast (teacher closed the
//     encoder). Once the archived video finishes processing on YouTube's
//     side, we insert a `videos` row automatically — pulling the
//     thumbnail YouTube generated and assigning the next sequential
//     video_number for that course. That's the "video automatically
//     gets stored/organised after I finish recording" requirement.
//     A teacher can still open that video afterwards to attach a PDF or
//     override the thumbnail (see routes/videos.js).

const db = require("../db");
const yt = require("./youtube");
const push = require("./push");

const POLL_MS = 15_000;
const REMINDER_WINDOW_MS = 5 * 60 * 1000; // "5 minutes before"
// If the server was down/slow near the reminder window, still send it up
// to 10 minutes late rather than silently skip it — but don't fire a
// reminder for a class whose start time is long past.
const REMINDER_LATE_GRACE_MS = 10 * 60 * 1000;

function nextVideoNumber(courseId) {
  const row = db
    .prepare("SELECT COALESCE(MAX(video_number), 0) AS n FROM videos WHERE course_id = ?")
    .get(courseId);
  return row.n + 1;
}

// Doesn't touch YouTube at all — purely "is scheduled_at within 5 minutes
// from now?" — so it runs on every poll regardless of whether Google
// creds are configured. Only needs push (VAPID) to actually send, and
// push.notifyLiveClassReminder() already no-ops safely if that's missing.
async function checkReminders() {
  const due = db
    .prepare(
      `SELECT * FROM live_classes
       WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND reminder_sent_at IS NULL`
    )
    .all();

  for (const lc of due) {
    const startMs = Date.parse(lc.scheduled_at);
    if (Number.isNaN(startMs)) continue;
    const msUntilStart = startMs - Date.now();
    if (msUntilStart <= REMINDER_WINDOW_MS && msUntilStart > -REMINDER_LATE_GRACE_MS) {
      try {
        const sent = await push.notifyLiveClassReminder(lc);
        db.prepare("UPDATE live_classes SET reminder_sent_at = datetime('now') WHERE id = ?").run(lc.id);
        console.log(`[sync] 5-min reminder sent for "${lc.title}" — notified ${sent} student(s)`);
      } catch (err) {
        console.error(`[sync] reminder failed for live_class ${lc.id}:`, err.message);
      }
    }
  }
}

async function pollOnce() {
  await checkReminders();

  if (!yt.isConfigured()) return; // nothing YouTube-related to do until Google creds are set

  // --- 1. scheduled -> live ---
  const scheduled = db
    .prepare("SELECT * FROM live_classes WHERE status = 'scheduled' AND youtube_broadcast_id IS NOT NULL")
    .all();
  for (const lc of scheduled) {
    try {
      const lifecycle = await yt.getBroadcastLifecycle(lc.youtube_broadcast_id);
      if (lifecycle === "live") {
        db.prepare(
          "UPDATE live_classes SET status = 'live', started_at = datetime('now') WHERE id = ?"
        ).run(lc.id);
        const updated = db.prepare("SELECT * FROM live_classes WHERE id = ?").get(lc.id);
        const sent = await push.notifyLiveClassStarted(updated);
        console.log(`[sync] "${lc.title}" went live — notified ${sent} student(s)`);
      }
    } catch (err) {
      console.error(`[sync] lifecycle check failed for live_class ${lc.id}:`, err.message);
    }
  }

  // --- 2. live -> ended ---
  const live = db.prepare("SELECT * FROM live_classes WHERE status = 'live'").all();
  for (const lc of live) {
    try {
      const lifecycle = await yt.getBroadcastLifecycle(lc.youtube_broadcast_id);
      if (lifecycle === "complete") {
        db.prepare(
          "UPDATE live_classes SET status = 'ended', ended_at = datetime('now'), youtube_video_id = ? WHERE id = ?"
        ).run(lc.youtube_broadcast_id, lc.id);
      }
    } catch (err) {
      console.error(`[sync] end-check failed for live_class ${lc.id}:`, err.message);
    }
  }

  // --- 3. ended, archived on YouTube, but not yet a `videos` row ---
  const pendingArchive = db
    .prepare(
      `SELECT lc.* FROM live_classes lc
       LEFT JOIN videos v ON v.live_class_id = lc.id
       WHERE lc.status = 'ended' AND lc.youtube_video_id IS NOT NULL AND v.id IS NULL`
    )
    .all();
  for (const lc of pendingArchive) {
    try {
      const info = await yt.getVideoStatus(lc.youtube_video_id);
      if (info && info.processingStatus === "succeeded") {
        const videoNumber = nextVideoNumber(lc.course_id);
        db.prepare(
          `INSERT INTO videos (course_id, live_class_id, title, video_number, youtube_video_id, thumbnail_path, access_type)
           VALUES (?,?,?,?,?,?,?)`
        ).run(
          lc.course_id,
          lc.id,
          info.title || lc.title,
          videoNumber,
          lc.youtube_video_id,
          info.thumbnail || null,
          lc.access_type
        );
        console.log(`[sync] "${lc.title}" archived as video #${videoNumber} in course ${lc.course_id}`);
      }
    } catch (err) {
      console.error(`[sync] archive-check failed for live_class ${lc.id}:`, err.message);
    }
  }
}

function start() {
  if (!yt.isConfigured()) {
    console.warn(
      "[sync] Google/YouTube credentials are not set — live status + auto-upload sync is paused. See .env.example."
    );
  }
  setInterval(() => {
    pollOnce().catch((err) => console.error("[sync] poll error:", err));
  }, POLL_MS);
}

module.exports = { start, pollOnce };
