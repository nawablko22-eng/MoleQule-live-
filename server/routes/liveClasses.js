const express = require("express");
const db = require("../db");
const { requireRole } = require("../middleware/auth");
const yt = require("../services/youtube");
const push = require("../services/push");
const { canAccess } = require("../services/access");

const router = express.Router();

function getCourseOr404(courseId, res) {
  const course = db.prepare("SELECT * FROM courses WHERE id = ?").get(courseId);
  if (!course) res.status(404).json({ error: "Course not found." });
  return course;
}

// POST /api/courses/:courseId/live-classes  (teacher)
// { title, access_type: 'enrolled_only' | 'open_to_all' }
// Creates the YouTube broadcast immediately and returns the stream key —
// the teacher pastes that into OBS (or a browser-based RTMP encoder) to
// actually go live; our background sync (server/services/youtubeSync.js)
// then notices when YouTube flips the broadcast to "live" and takes it
// from there (notification, and later the auto-archived video).
router.post("/courses/:courseId/live-classes", requireRole("teacher"), async (req, res) => {
  const course = getCourseOr404(req.params.courseId, res);
  if (!course) return;
  if (course.teacher_id !== req.user.id) {
    return res.status(403).json({ error: "You can only schedule live classes for your own courses." });
  }

  const { title, access_type, privacy_status, scheduled_at } = req.body;
  if (!title) return res.status(400).json({ error: "Live class title is required." });
  const accessType = access_type === "open_to_all" ? "open_to_all" : "enrolled_only";
  // Required — students need to know when to show up, and this also
  // powers the automatic "5 minutes before" reminder (see checkReminders()
  // in services/youtubeSync.js).
  if (!scheduled_at) {
    return res.status(400).json({ error: "Set a date and time for this live class." });
  }
  const parsed = Date.parse(scheduled_at);
  if (Number.isNaN(parsed)) {
    return res.status(400).json({ error: "That date/time isn't valid." });
  }
  const scheduledAt = new Date(parsed).toISOString();
  // Teacher's explicit choice wins; otherwise default sensibly from access_type
  // (see the big comment on createBroadcastForLiveClass for why 'unlisted',
  // not 'private', is what actually makes "enrolled students only" work at
  // class size).
  const privacyStatus = ["private", "unlisted", "public"].includes(privacy_status)
    ? privacy_status
    : accessType === "open_to_all" ? "public" : "unlisted";

  if (!yt.isConfigured()) {
    return res.status(409).json({
      error:
        "YouTube isn't connected yet. A teacher admin needs to visit /api/youtube/oauth/start once and save the refresh token — see README.",
    });
  }

  try {
    const broadcast = await yt.createBroadcastForLiveClass({
      title,
      description: course.title,
      accessType,
      privacyStatus,
    });
    const info = db
      .prepare(
        `INSERT INTO live_classes
           (course_id, title, access_type, status, youtube_broadcast_id, youtube_stream_id,
            youtube_stream_key, youtube_ingestion_url, youtube_studio_url, youtube_privacy_status,
            scheduled_at)
         VALUES (?,?,?, 'scheduled', ?,?,?,?,?,?,?)`
      )
      .run(
        course.id,
        title,
        accessType,
        broadcast.broadcastId,
        broadcast.streamId,
        broadcast.streamKey,
        broadcast.ingestionUrl,
        broadcast.studioUrl,
        broadcast.privacyStatus,
        scheduledAt
      );

    const liveClass = db.prepare("SELECT * FROM live_classes WHERE id = ?").get(info.lastInsertRowid);

    // Notification #1 of 3: fires right now, the moment the class is
    // scheduled. (#2 is the automatic 5-minutes-before reminder, if
    // scheduledAt was given — see youtubeSync.js. #3 is "live now", fired
    // when the broadcast actually starts.) A push failure here shouldn't
    // fail class creation, so it's caught and just logged.
    let notifiedNow = 0;
    try {
      notifiedNow = await push.notifyLiveClassScheduled(liveClass);
    } catch (err) {
      console.error("[push] 'scheduled' notification failed:", err.message);
    }

    res.json({
      live_class: liveClass,
      go_live: {
        ingestion_url: broadcast.ingestionUrl,
        stream_key: broadcast.streamKey,
        studio_url: broadcast.studioUrl,
        privacy_status: broadcast.privacyStatus,
        note:
          "Two ways to go live: (1) click 'Open YouTube Studio' and stream straight from your webcam in the browser, or (2) paste the ingestion URL + stream key into OBS (Settings > Stream > Custom). Either way, students get notified automatically within ~15s of the stream actually starting.",
      },
      notified: {
        sent_now: notifiedNow,
        note: `Students were just notified this class is scheduled (${notifiedNow} sent). They'll also get an automatic reminder 5 minutes before the time you set, then the "live now" push once you actually start streaming.`,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Could not create the YouTube broadcast: " + err.message });
  }
});

// GET /api/courses/:courseId/live-classes — list, filtered to what this
// viewer (teacher / enrolled student / guest) is actually allowed to see.
router.get("/courses/:courseId/live-classes", (req, res) => {
  const course = getCourseOr404(req.params.courseId, res);
  if (!course) return;
  const rows = db
    .prepare("SELECT * FROM live_classes WHERE course_id = ? ORDER BY created_at DESC")
    .all(course.id);

  const visible = rows
    .filter((lc) => canAccess({ courseId: course.id, accessType: lc.access_type, teacherId: course.teacher_id }, req.user))
    .map((lc) => {
      const isTeacher = req.user?.role === "teacher" && req.user.id === course.teacher_id;
      // Students/guests never see the stream key or the teacher's own
      // YouTube Studio control-room link — only the teacher does.
      const { youtube_stream_key, youtube_ingestion_url, youtube_studio_url, ...safe } = lc;
      return isTeacher ? lc : safe;
    });

  res.json({ live_classes: visible });
});

// GET /api/live-classes/:id — single class, access-checked. Students use
// this to get the watch URL once status is 'live'.
router.get("/live-classes/:id", (req, res) => {
  const lc = db.prepare("SELECT * FROM live_classes WHERE id = ?").get(req.params.id);
  if (!lc) return res.status(404).json({ error: "Live class not found." });
  const course = db.prepare("SELECT * FROM courses WHERE id = ?").get(lc.course_id);

  const allowed = canAccess(
    { courseId: lc.course_id, accessType: lc.access_type, teacherId: course.teacher_id },
    req.user
  );
  if (!allowed) {
    return res.status(403).json({
      error:
        lc.access_type === "enrolled_only"
          ? "This live class is only for students registered in this course."
          : "Sign in to view this class.",
    });
  }

  const isTeacher = req.user?.role === "teacher" && req.user.id === course.teacher_id;
  const { youtube_stream_key, youtube_ingestion_url, youtube_studio_url, ...safe } = lc;
  res.json({
    live_class: isTeacher ? lc : safe,
    watch_url:
      lc.status === "live" || lc.status === "ended"
        ? `https://www.youtube.com/watch?v=${lc.youtube_broadcast_id}`
        : null,
  });
});

// POST /api/live-classes/:id/end (teacher) — manual fallback in case
// enableAutoStop didn't fire (e.g. the encoder crashed instead of closing
// cleanly).
router.post("/live-classes/:id/end", requireRole("teacher"), async (req, res) => {
  const lc = db.prepare("SELECT * FROM live_classes WHERE id = ?").get(req.params.id);
  if (!lc) return res.status(404).json({ error: "Live class not found." });
  try {
    await yt.transitionBroadcast(lc.youtube_broadcast_id, "complete");
    db.prepare(
      "UPDATE live_classes SET status = 'ended', ended_at = datetime('now'), youtube_video_id = ? WHERE id = ?"
    ).run(lc.youtube_broadcast_id, lc.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// POST /api/live-classes/:id/attendance/ping (student) — watch.html calls
// this once on load and every ~20s while the tab stays open on a live
// class. First ping creates the row (joined_at); every ping after that
// just bumps last_seen_at, which is how attendance duration is estimated.
router.post("/live-classes/:id/attendance/ping", requireRole("student"), (req, res) => {
  const lc = db.prepare("SELECT * FROM live_classes WHERE id = ?").get(req.params.id);
  if (!lc || lc.status !== "live") return res.json({ ok: true }); // quietly no-op once the class ends — nothing to track
  db.prepare(
    `INSERT INTO attendance (live_class_id, student_id) VALUES (?, ?)
     ON CONFLICT(live_class_id, student_id) DO UPDATE SET last_seen_at = datetime('now')`
  ).run(lc.id, req.user.id);
  res.json({ ok: true });
});

// GET /api/live-classes/:id/attendance (teacher, own course) — who joined,
// roughly how long, newest first.
router.get("/live-classes/:id/attendance", requireRole("teacher"), (req, res) => {
  const lc = db.prepare("SELECT * FROM live_classes WHERE id = ?").get(req.params.id);
  if (!lc) return res.status(404).json({ error: "Live class not found." });
  const course = db.prepare("SELECT * FROM courses WHERE id = ?").get(lc.course_id);
  if (!course || course.teacher_id !== req.user.id) {
    return res.status(403).json({ error: "You can only view attendance for your own courses." });
  }
  const attendance = db
    .prepare(
      `SELECT a.*, u.name AS student_name, u.phone AS student_phone
       FROM attendance a JOIN users u ON u.id = a.student_id
       WHERE a.live_class_id = ? ORDER BY a.joined_at DESC`
    )
    .all(lc.id);
  res.json({ attendance });
});

module.exports = router;
