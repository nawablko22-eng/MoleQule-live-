// Percentage-off coupon codes: a teacher's own promo codes (manually
// created here) plus the auto-generated ones from a successful referral
// (services/referrals.js) — both live in the same `coupons` table and
// both work at checkout the same way (see routes/cart.js).

const express = require("express");
const db = require("../db");
const { requireRole } = require("../middleware/auth");

const router = express.Router();

function isExpired(coupon) {
  return Boolean(coupon.expires_at && new Date(coupon.expires_at) < new Date());
}

// Shared by cart.js too — kept here since coupons are "this file's table".
// Returns { ok: true, coupon } or { ok: false, error }.
function checkCoupon(code, studentId) {
  const coupon = db.prepare("SELECT * FROM coupons WHERE code = ?").get(String(code || "").trim().toUpperCase());
  if (!coupon) return { ok: false, error: "That coupon code doesn't exist." };
  if (!coupon.active) return { ok: false, error: "That coupon isn't active anymore." };
  if (isExpired(coupon)) return { ok: false, error: "That coupon has expired." };
  if (coupon.max_uses !== null && coupon.used_count >= coupon.max_uses) {
    return { ok: false, error: "That coupon has already been used up." };
  }
  if (coupon.owner_student_id && coupon.owner_student_id !== studentId) {
    return { ok: false, error: "That coupon belongs to a different account." };
  }
  return { ok: true, coupon };
}

// POST /api/coupons/validate  { code }  (student) — live preview on the
// cart page, before actually checking out.
router.post("/coupons/validate", requireRole("student"), (req, res) => {
  const result = checkCoupon(req.body.code, req.user.id);
  if (!result.ok) return res.status(400).json({ valid: false, error: result.error });
  res.json({ valid: true, discount_percent: result.coupon.discount_percent, code: result.coupon.code });
});

// GET /api/coupons/featured — public, no login required. Used for the
// promo banner on the home page: the single best currently-usable manual
// coupon (referral coupons are personal, so they never show up here),
// or { coupon: null } if there isn't one. Only exposes what's needed to
// advertise it — no ids, no usage counts.
router.get("/coupons/featured", (req, res) => {
  const coupon = db
    .prepare(
      `SELECT code, discount_percent FROM coupons
       WHERE source = 'manual' AND active = 1
         AND (expires_at IS NULL OR expires_at > datetime('now'))
         AND (max_uses IS NULL OR used_count < max_uses)
       ORDER BY discount_percent DESC LIMIT 1`
    )
    .get();
  res.json({ coupon: coupon || null });
});

// GET /api/coupons  (teacher) — manage tab. Includes referral-generated
// coupons too (read-only there — see public/teacher.html).
router.get("/coupons", requireRole("teacher"), (req, res) => {
  const coupons = db
    .prepare("SELECT * FROM coupons WHERE created_by = ? OR source = 'referral' ORDER BY created_at DESC")
    .all(req.user.id);
  res.json({ coupons });
});

// POST /api/coupons  { code, discount_percent, max_uses?, expires_at? }  (teacher)
router.post("/coupons", requireRole("teacher"), (req, res) => {
  const { code, discount_percent, max_uses, expires_at } = req.body;
  const cleanCode = String(code || "").trim().toUpperCase();
  const percent = Number(discount_percent);

  if (!cleanCode) return res.status(400).json({ error: "A coupon code is required." });
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    return res.status(400).json({ error: "Discount percent must be between 1 and 100." });
  }
  const exists = db.prepare("SELECT 1 FROM coupons WHERE code = ?").get(cleanCode);
  if (exists) return res.status(409).json({ error: "A coupon with that code already exists." });

  const maxUses = max_uses !== undefined && max_uses !== null && max_uses !== "" ? Math.max(1, Math.round(Number(max_uses))) : null;
  const expiresAt = expires_at ? new Date(expires_at).toISOString() : null;

  const info = db
    .prepare(
      `INSERT INTO coupons (code, discount_percent, max_uses, expires_at, source, created_by)
       VALUES (?,?,?,?, 'manual', ?)`
    )
    .run(cleanCode, Math.round(percent), maxUses, expiresAt, req.user.id);

  res.json({ coupon: db.prepare("SELECT * FROM coupons WHERE id = ?").get(info.lastInsertRowid) });
});

// PATCH /api/coupons/:id  { active }  (teacher) — on/off toggle
router.patch("/coupons/:id", requireRole("teacher"), (req, res) => {
  const coupon = db.prepare("SELECT * FROM coupons WHERE id = ? AND created_by = ?").get(req.params.id, req.user.id);
  if (!coupon) return res.status(404).json({ error: "Coupon not found." });
  if (typeof req.body.active !== "undefined") {
    db.prepare("UPDATE coupons SET active = ? WHERE id = ?").run(req.body.active ? 1 : 0, coupon.id);
  }
  res.json({ coupon: db.prepare("SELECT * FROM coupons WHERE id = ?").get(coupon.id) });
});

// DELETE /api/coupons/:id  (teacher) — only their own manual coupons;
// referral coupons aren't teacher-deletable since a student may be
// relying on one they were promised.
router.delete("/coupons/:id", requireRole("teacher"), (req, res) => {
  db.prepare("DELETE FROM coupons WHERE id = ? AND created_by = ? AND source = 'manual'").run(req.params.id, req.user.id);
  res.json({ ok: true });
});

module.exports = { router, checkCoupon };
