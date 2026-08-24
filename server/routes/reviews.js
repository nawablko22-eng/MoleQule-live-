// Student reviews/testimonials, shown on the home page. One review per
// student (they edit their existing one rather than posting many). A
// teacher moderates from the admin Reviews panel: hide/un-hide (keeps the
// review, just stops showing it publicly) or delete outright. See
// db.js's reviews table comment for the "editing doesn't un-hide" rule.

const express = require("express");
const db = require("../db");
const { requireRole } = require("../middleware/auth");

const router = express.Router();

// GET /api/reviews — public. Only visible reviews, newest first, plus a
// quick average/count so the home page can show "4.8 (23 reviews)".
router.get("/reviews", (req, res) => {
  const reviews = db
    .prepare(
      `SELECT r.id, r.rating, r.text, r.created_at, u.name AS student_name
       FROM reviews r JOIN users u ON u.id = r.student_id
       WHERE r.visible = 1 ORDER BY r.created_at DESC`
    )
    .all();
  const summary = db.prepare("SELECT COUNT(*) AS count, AVG(rating) AS avg_rating FROM reviews WHERE visible = 1").get();
  res.json({
    reviews,
    summary: { count: summary.count, avg_rating: summary.avg_rating ? Math.round(summary.avg_rating * 10) / 10 : null },
  });
});

// GET /api/reviews/me — the logged-in student's own review (any
// visibility), so the "leave a review" form can prefill it for editing.
router.get("/reviews/me", requireRole("student"), (req, res) => {
  const review = db.prepare("SELECT * FROM reviews WHERE student_id = ?").get(req.user.id);
  res.json({ review: review || null });
});

// POST /api/reviews  { rating, text }  (student) — creates their review
// the first time (visible immediately), or updates the text/rating of
// their existing one on any later call. Visibility is untouched by an
// edit -- if a teacher hid it, it stays hidden until a teacher says
// otherwise, so this can't be used to quietly bypass moderation.
router.post("/reviews", requireRole("student"), (req, res) => {
  const rating = Number(req.body.rating);
  const text = typeof req.body.text === "string" ? req.body.text.trim() : "";
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: "Rating must be 1 to 5." });
  }
  if (!text) return res.status(400).json({ error: "Write a few words for your review." });

  const existing = db.prepare("SELECT id FROM reviews WHERE student_id = ?").get(req.user.id);
  if (existing) {
    db.prepare("UPDATE reviews SET rating = ?, text = ?, updated_at = datetime('now') WHERE id = ?").run(rating, text, existing.id);
  } else {
    db.prepare("INSERT INTO reviews (student_id, rating, text) VALUES (?, ?, ?)").run(req.user.id, rating, text);
  }
  const review = db.prepare("SELECT * FROM reviews WHERE student_id = ?").get(req.user.id);
  res.json({ review });
});

// ---- Admin moderation (teacher-only) ----

// GET /api/admin/reviews — every review, visible or not.
router.get("/admin/reviews", requireRole("teacher"), (req, res) => {
  const reviews = db
    .prepare(
      `SELECT r.id, r.rating, r.text, r.visible, r.created_at, r.updated_at, u.id AS student_id, u.name AS student_name, u.phone AS student_phone
       FROM reviews r JOIN users u ON u.id = r.student_id
       ORDER BY r.created_at DESC`
    )
    .all();
  res.json({ reviews });
});

// PATCH /api/admin/reviews/:id  { visible: boolean }
router.patch("/admin/reviews/:id", requireRole("teacher"), (req, res) => {
  const review = db.prepare("SELECT * FROM reviews WHERE id = ?").get(req.params.id);
  if (!review) return res.status(404).json({ error: "Review not found." });
  const visible = req.body.visible ? 1 : 0;
  db.prepare("UPDATE reviews SET visible = ? WHERE id = ?").run(visible, review.id);
  res.json({ review: db.prepare("SELECT * FROM reviews WHERE id = ?").get(review.id) });
});

// DELETE /api/admin/reviews/:id
router.delete("/admin/reviews/:id", requireRole("teacher"), (req, res) => {
  const review = db.prepare("SELECT * FROM reviews WHERE id = ?").get(req.params.id);
  if (!review) return res.status(404).json({ error: "Review not found." });
  db.prepare("DELETE FROM reviews WHERE id = ?").run(review.id);
  res.json({ ok: true });
});

module.exports = router;
