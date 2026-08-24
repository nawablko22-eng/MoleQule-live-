const express = require("express");
const db = require("../db");
const { requireRole } = require("../middleware/auth");
const access = require("../services/access");

const router = express.Router();

// A course's access lasts this many days from the moment a student
// registers (free) or their payment completes (paid) -- see
// services/orders.js completeOrder and POST /:id/enroll below. Kept as a
// fixed preset list (rather than any free-form number) so every course on
// the platform uses one of the same well-understood durations.
const VALIDITY_OPTIONS = [7, 15, 30, 90, 180, 365, 730];
const VALIDITY_LABELS = { 7: "7 days", 15: "15 days", 30: "1 month", 90: "3 months", 180: "6 months", 365: "12 months", 730: "24 months" };

// POST /api/courses  (teacher)  { title, description, price, validity_days }
router.post("/", requireRole("teacher"), (req, res) => {
  const { title, description, price, validity_days } = req.body;
  if (!title) return res.status(400).json({ error: "Course title is required." });
  const priceNum = Number(price);
  const validityDays = Number(validity_days);
  if (!VALIDITY_OPTIONS.includes(validityDays)) {
    return res.status(400).json({ error: "Choose an access validity (7 days to 24 months) for this course." });
  }
  const info = db
    .prepare("INSERT INTO courses (teacher_id, title, description, price, validity_days) VALUES (?,?,?,?,?)")
    .run(
      req.user.id,
      title,
      description || "",
      Number.isFinite(priceNum) && priceNum > 0 ? Math.round(priceNum) : 0,
      validityDays
    );
  res.json({ course: db.prepare("SELECT * FROM courses WHERE id = ?").get(info.lastInsertRowid) });
});

// PATCH /api/courses/:id  { validity_days }  (teacher, own course) —
// changes ONLY apply to students who register/renew from now on; anyone
// already enrolled keeps the expiry that was already computed for them
// (same "frozen at the time" rule as order_items.price).
router.patch("/:id", requireRole("teacher"), (req, res) => {
  const course = db.prepare("SELECT * FROM courses WHERE id = ?").get(req.params.id);
  if (!course || course.teacher_id !== req.user.id) {
    return res.status(404).json({ error: "Course not found." });
  }
  const validityDays = Number(req.body.validity_days);
  if (!VALIDITY_OPTIONS.includes(validityDays)) {
    return res.status(400).json({ error: "Choose an access validity (7 days to 24 months)." });
  }
  db.prepare("UPDATE courses SET validity_days = ? WHERE id = ?").run(validityDays, course.id);
  res.json({ course: db.prepare("SELECT * FROM courses WHERE id = ?").get(course.id) });
});

// GET /api/courses  -> public list, each with whether the current viewer
// (if a logged-in student) is currently, actively registered -- an
// expired registration reads as is_enrolled: false (so the buy/register
// button comes back) but access_expired: true (so the UI can say "your
// access expired" instead of acting like they never signed up).
router.get("/", (req, res) => {
  const courses = db.prepare("SELECT * FROM courses ORDER BY created_at DESC").all();
  const studentId = req.user?.role === "student" ? req.user.id : null;
  const enriched = courses.map((c) => {
    const enrollment = access.getEnrollment(c.id, studentId);
    const expired = enrollment ? access.isExpired(enrollment.expires_at) : false;
    return {
      ...c,
      is_enrolled: !!enrollment && !expired,
      access_expired: !!enrollment && expired,
      access_expires_at: enrollment ? enrollment.expires_at : null,
      student_count: db.prepare("SELECT COUNT(*) n FROM enrollments WHERE course_id = ?").get(c.id).n,
    };
  });
  res.json({ courses: enriched, validity_labels: VALIDITY_LABELS });
});

router.get("/:id", (req, res) => {
  const course = db.prepare("SELECT * FROM courses WHERE id = ?").get(req.params.id);
  if (!course) return res.status(404).json({ error: "Course not found." });
  res.json({ course });
});

// POST /api/courses/:id/enroll  (student "registers" for the course —
// in production this sits behind your payment/checkout step)
router.post("/:id/enroll", requireRole("student"), (req, res) => {
  const course = db.prepare("SELECT * FROM courses WHERE id = ?").get(req.params.id);
  if (!course) return res.status(404).json({ error: "Course not found." });
  // Free enrollment is only for actually-free courses -- a paid one has to
  // go through cart + checkout (routes/cart.js), which is where payment is
  // actually verified. Without this check, this endpoint would let anyone
  // register for a paid course for ₹0 just by calling it directly.
  if (course.price > 0) {
    return res.status(402).json({ error: "This is a paid course — add it to your cart and complete checkout to register." });
  }

  const existing = access.getEnrollment(course.id, req.user.id);
  if (existing && !access.isExpired(existing.expires_at)) {
    return res.json({ ok: true }); // already actively registered, nothing to do
  }
  if (existing) {
    // Renewing a free course whose access already ran out -- UPDATE, not
    // INSERT OR IGNORE, since the old row (and its UNIQUE(course_id,
    // student_id)) is still there and would otherwise silently block a
    // re-registration forever.
    db.prepare(
      `UPDATE enrollments SET enrolled_at = datetime('now'),
         expires_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', '+' || ? || ' days') END
       WHERE id = ?`
    ).run(course.validity_days, course.validity_days, existing.id);
  } else {
    db.prepare(
      `INSERT INTO enrollments (course_id, student_id, expires_at)
       VALUES (?, ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', '+' || ? || ' days') END)`
    ).run(course.id, req.user.id, course.validity_days, course.validity_days);
  }
  res.json({ ok: true });
});

// GET /api/courses/:id/students  (teacher) — the registered roster,
// including whether each student's access has since expired.
router.get("/:id/students", requireRole("teacher"), (req, res) => {
  const rows = db
    .prepare(
      `SELECT u.id, u.name, u.phone, u.parent_phone, e.enrolled_at, e.expires_at
       FROM enrollments e JOIN users u ON u.id = e.student_id
       WHERE e.course_id = ? ORDER BY e.enrolled_at DESC`
    )
    .all(req.params.id);
  const withExpiry = rows.map((r) => ({ ...r, access_expired: access.isExpired(r.expires_at) }));
  res.json({ students: withExpiry });
});

module.exports = router;
