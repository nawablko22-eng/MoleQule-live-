const express = require("express");
const db = require("../db");
const { requireRole } = require("../middleware/auth");

const router = express.Router();

// POST /api/analytics/track — public, no auth. Fired by a tiny beacon on
// page load (see public/js/track.js). course_id is null for a site-wide
// page (login, etc.) and set when the visit is on a specific course.
router.post("/analytics/track", (req, res) => {
  const { event_type, course_id, path } = req.body || {};
  if (!["visit", "course_view"].includes(event_type)) {
    return res.status(400).json({ error: "Invalid event_type." });
  }
  db.prepare("INSERT INTO analytics_events (event_type, course_id, path) VALUES (?,?,?)").run(
    event_type,
    course_id || null,
    (path || "").slice(0, 200)
  );
  res.status(204).end();
});

// GET /api/admin/overview (teacher) — everything the admin dashboard needs:
// site visitors, per-course views/students/revenue, and a 7-day trend.
// Scoped to the requesting teacher's own courses — this is a one-teacher-
// per-course platform, so "admin" here means "owner of these courses".
router.get("/admin/overview", requireRole("teacher"), (req, res) => {
  const courses = db.prepare("SELECT * FROM courses WHERE teacher_id = ?").all(req.user.id);
  const courseIds = courses.map((c) => c.id);
  const placeholders = courseIds.length ? courseIds.map(() => "?").join(",") : "NULL";

  const perCourse = courses.map((c) => {
    const students = db.prepare("SELECT COUNT(*) n FROM enrollments WHERE course_id = ?").get(c.id).n;
    const views = db
      .prepare("SELECT COUNT(*) n FROM analytics_events WHERE event_type = 'course_view' AND course_id = ?")
      .get(c.id).n;
    return {
      id: c.id,
      title: c.title,
      price: c.price,
      students,
      views,
      revenue: c.price * students,
    };
  });

  const totalStudents = courseIds.length
    ? db
        .prepare(`SELECT COUNT(DISTINCT student_id) n FROM enrollments WHERE course_id IN (${placeholders})`)
        .get(...courseIds).n
    : 0;
  const totalRevenue = perCourse.reduce((sum, c) => sum + c.revenue, 0);
  const totalCourseViews = perCourse.reduce((sum, c) => sum + c.views, 0);

  // Site-wide visitors: every 'visit' event, whether or not it happened
  // on one of this teacher's course pages (this app is single-teacher-
  // per-instance, so "the website's" traffic is all of it).
  const totalVisitors = db.prepare("SELECT COUNT(*) n FROM analytics_events WHERE event_type = 'visit'").get().n;

  // Last 7 days, day-bucketed, for the trend chart.
  const days = [...Array(7)].map((_, i) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - (6 - i));
    return d.toISOString().slice(0, 10);
  });
  const dailyVisitors = days.map((date) => ({
    date,
    count: db
      .prepare("SELECT COUNT(*) n FROM analytics_events WHERE event_type = 'visit' AND substr(created_at,1,10) = ?")
      .get(date).n,
  }));
  const dailyEnrollments = days.map((date) => {
    const row = courseIds.length
      ? db
          .prepare(
            `SELECT COUNT(*) n FROM enrollments WHERE course_id IN (${placeholders}) AND substr(enrolled_at,1,10) = ?`
          )
          .get(...courseIds, date)
      : { n: 0 };
    return { date, count: row.n };
  });

  res.json({
    totals: {
      visitors: totalVisitors,
      students: totalStudents,
      revenue: totalRevenue,
      course_views: totalCourseViews,
      courses: courses.length,
    },
    per_course: perCourse,
    daily_visitors: dailyVisitors,
    daily_enrollments: dailyEnrollments,
  });
});

module.exports = router;
