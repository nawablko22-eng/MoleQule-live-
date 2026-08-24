const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { issueToken, requireAuth } = require("../middleware/auth");
const googleAuth = require("../services/googleAuth");
const email = require("../services/email");
const referrals = require("../services/referrals");

const router = express.Router();

function setSessionCookie(res, user) {
  const token = issueToken(user);
  res.cookie("token", token, { httpOnly: true, sameSite: "lax", maxAge: 30 * 24 * 3600 * 1000 });
}

// POST /api/auth/register  { name, phone, password, role: 'teacher'|'student', referral_code? }
router.post("/register", (req, res) => {
  const { name, phone, password, role, referral_code } = req.body;
  if (!name || !phone || !password || !["teacher", "student"].includes(role)) {
    return res.status(400).json({ error: "name, phone, password and a valid role are required." });
  }
  const exists = db.prepare("SELECT id FROM users WHERE phone = ?").get(phone);
  if (exists) return res.status(409).json({ error: "An account with this phone number already exists." });

  // Referral code is optional and never blocks signup — an unknown/typo'd
  // code is just silently ignored rather than rejecting the whole form.
  let referrer = null;
  if (typeof referral_code === "string" && referral_code.trim()) {
    referrer = db.prepare("SELECT * FROM users WHERE referral_code = ?").get(referral_code.trim().toUpperCase());
  }

  const hash = bcrypt.hashSync(password, 10);
  const myReferralCode = referrals.generateUniqueReferralCode();
  const info = db
    .prepare("INSERT INTO users (name, phone, password_hash, role, referral_code) VALUES (?,?,?,?,?)")
    .run(name, phone, hash, role, myReferralCode);

  let reward = null;
  if (referrer && referrer.id !== info.lastInsertRowid) {
    reward = referrals.rewardReferral(referrer.id, info.lastInsertRowid);
  }

  const user = { id: info.lastInsertRowid, name, role };
  setSessionCookie(res, user);
  res.json({
    user,
    referral_code: myReferralCode,
    ...(reward ? { welcome_coupon: reward.referredCoupon, welcome_discount_percent: reward.discountPercent } : {}),
  });
});

// POST /api/auth/login  { phone, password }
router.post("/login", (req, res) => {
  const { phone, password } = req.body;
  const row = db.prepare("SELECT * FROM users WHERE phone = ?").get(phone);
  if (!row || !bcrypt.compareSync(password || "", row.password_hash)) {
    return res.status(401).json({ error: "Phone number or password is incorrect." });
  }
  const user = { id: row.id, name: row.name, role: row.role };
  setSessionCookie(res, user);
  res.json({ user });
});

// GET /api/auth/google/start?role=student|teacher&next=/some/page
// role only matters for a brand-new account (an existing one keeps its
// real role); next is where to send them back afterwards.
router.get("/google/start", (req, res) => {
  if (!googleAuth.isConfigured()) {
    return res
      .status(409)
      .send("Google sign-in isn't set up yet — GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET need to be added to .env. See README.");
  }
  const role = req.query.role === "teacher" ? "teacher" : "student";
  const next = typeof req.query.next === "string" && req.query.next.startsWith("/") ? req.query.next : "";
  const state = Buffer.from(JSON.stringify({ role, next })).toString("base64url");
  res.redirect(googleAuth.getAuthUrl(state));
});

// GET /api/auth/google/callback — Google redirects here after consent.
router.get("/google/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send("Google sign-in was cancelled.");

  let parsedState = { role: "student", next: "" };
  try {
    parsedState = JSON.parse(Buffer.from(String(state || ""), "base64url").toString("utf8"));
  } catch { /* malformed/missing state — fall back to the defaults above */ }

  try {
    const profile = await googleAuth.getProfile(code);
    if (!profile.email) {
      return res.status(400).send("Your Google account didn't share an email address, so we can't sign you in with it.");
    }

    let row = db.prepare("SELECT * FROM users WHERE google_id = ?").get(profile.googleId);
    if (!row) {
      // Not linked yet — but an account with this email might already
      // exist (e.g. they originally signed up with phone + password using
      // the same email later, or vice versa). Link it instead of creating
      // a duplicate.
      row = db.prepare("SELECT * FROM users WHERE email = ?").get(profile.email);
      if (row) {
        db.prepare("UPDATE users SET google_id = ? WHERE id = ?").run(profile.googleId, row.id);
      } else {
        const myReferralCode = referrals.generateUniqueReferralCode();
        const info = db
          .prepare("INSERT INTO users (name, email, google_id, role, referral_code) VALUES (?,?,?,?,?)")
          .run(profile.name || profile.email, profile.email, profile.googleId, parsedState.role, myReferralCode);
        row = db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
      }
    }

    setSessionCookie(res, { id: row.id, name: row.name, role: row.role });
    res.redirect(parsedState.next || (row.role === "teacher" ? "/teacher.html" : "/student.html"));
  } catch (err) {
    console.error("[auth] Google sign-in failed:", err.message);
    res.status(502).send("Google sign-in failed: " + err.message);
  }
});

router.post("/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ ok: true });
});

// GET /api/auth/me — always reads the full profile fresh from the
// database (not just what's cached in the JWT), so email/phone show up
// as soon as they're filled in — see PATCH below and the cart's
// "complete your details" step.
router.get("/me", (req, res) => {
  if (!req.user) return res.json({ user: null });
  const row = db
    .prepare("SELECT id, name, phone, email, role, referral_code, parent_phone FROM users WHERE id = ?")
    .get(req.user.id);
  res.json({ user: row || null });
});

// PATCH /api/auth/me  { name?, email?, phone?, parent_phone? } — fills in
// whatever's missing from a Google sign-in account (no phone) or an
// older phone account (no email); a student can also add/update a
// parent/guardian's WhatsApp number here, used for weekly progress
// reports (see services/parentReports.js). Used by the cart's "complete
// your details" step right before checkout too — see public/cart.html.
router.patch("/me", requireAuth, (req, res) => {
  const { name, email, phone, parent_phone } = req.body;
  const sets = [];
  const params = [];

  if (typeof name === "string" && name.trim()) {
    sets.push("name = ?");
    params.push(name.trim());
  }
  if (typeof email === "string" && email.trim()) {
    const value = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      return res.status(400).json({ error: "That doesn't look like a valid email address." });
    }
    const clash = db.prepare("SELECT id FROM users WHERE email = ? AND id != ?").get(value, req.user.id);
    if (clash) return res.status(409).json({ error: "That email is already linked to another account." });
    sets.push("email = ?");
    params.push(value);
  }
  if (typeof phone === "string" && phone.trim()) {
    const value = phone.trim();
    const clash = db.prepare("SELECT id FROM users WHERE phone = ? AND id != ?").get(value, req.user.id);
    if (clash) return res.status(409).json({ error: "That phone number is already linked to another account." });
    sets.push("phone = ?");
    params.push(value);
  }
  // parent_phone has no uniqueness constraint (siblings can share one
  // number) and an empty string clears it, unlike the fields above.
  if (typeof parent_phone === "string") {
    sets.push("parent_phone = ?");
    params.push(parent_phone.trim() || null);
  }

  if (!sets.length) return res.status(400).json({ error: "Nothing to update." });
  params.push(req.user.id);
  db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...params);

  const row = db.prepare("SELECT id, name, phone, email, role, referral_code, parent_phone FROM users WHERE id = ?").get(req.user.id);
  res.json({ user: row });
});

// DELETE /api/auth/me — students only (a teacher account deleting itself
// would also need to decide what happens to their courses/live
// classes/videos, which is a bigger, more consequential operation than
// this self-service button is meant for). Removes this student's cart,
// enrollments, push subscriptions, and orders, then the account itself.
router.delete("/me", requireAuth, (req, res) => {
  if (req.user.role !== "student") {
    return res.status(403).json({ error: "Account deletion from here is for student accounts. Contact support for a teacher account." });
  }
  const studentId = req.user.id;
  const deleteAccount = db.transaction(() => {
    db.prepare("DELETE FROM cart_items WHERE student_id = ?").run(studentId);
    db.prepare("DELETE FROM enrollments WHERE student_id = ?").run(studentId);
    db.prepare("DELETE FROM push_subscriptions WHERE student_id = ?").run(studentId);
    const orderIds = db.prepare("SELECT id FROM orders WHERE student_id = ?").all(studentId).map((o) => o.id);
    for (const orderId of orderIds) {
      db.prepare("DELETE FROM order_items WHERE order_id = ?").run(orderId);
    }
    db.prepare("DELETE FROM orders WHERE student_id = ?").run(studentId);
    db.prepare("DELETE FROM coupons WHERE owner_student_id = ?").run(studentId);
    db.prepare("DELETE FROM referrals WHERE referrer_id = ? OR referred_id = ?").run(studentId, studentId);
    db.prepare("DELETE FROM users WHERE id = ?").run(studentId);
  });
  deleteAccount();
  res.clearCookie("token");
  res.json({ ok: true });
});

// POST /api/auth/forgot-password  { email }
// Always responds the same way whether or not the email matches an
// account — otherwise this endpoint would let anyone check which emails
// are registered.
router.post("/forgot-password", async (req, res) => {
  const generic = { ok: true, message: "If that email is on an account here, a reset link is on its way." };
  const emailInput = typeof req.body.email === "string" ? req.body.email.trim() : "";
  if (!emailInput) return res.status(400).json({ error: "Enter the email on your account." });

  if (!email.isConfigured()) {
    return res.status(409).json({
      error: "Password reset emails aren't set up yet on this server — see README (SMTP_HOST/SMTP_USER/SMTP_PASS).",
    });
  }

  const row = db.prepare("SELECT * FROM users WHERE email = ?").get(emailInput);
  if (!row) return res.json(generic); // don't reveal whether the email exists

  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 3600 * 1000).toISOString(); // 1 hour
  db.prepare("UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?").run(token, expires, row.id);

  const resetUrl = `${process.env.BASE_URL || "http://localhost:4000"}/reset-password.html?token=${token}`;
  try {
    await email.sendPasswordResetEmail(row.email, resetUrl);
  } catch (err) {
    console.error("[auth] failed to send password reset email:", err.message);
    return res.status(502).json({ error: "Couldn't send the reset email right now — try again shortly." });
  }
  res.json(generic);
});

// POST /api/auth/reset-password  { token, password }
router.post("/reset-password", (req, res) => {
  const { token, password } = req.body;
  if (!token || !password || password.length < 6) {
    return res.status(400).json({ error: "A valid reset link and a password (6+ characters) are required." });
  }
  const row = db.prepare("SELECT * FROM users WHERE reset_token = ?").get(token);
  if (!row || !row.reset_token_expires || new Date(row.reset_token_expires) < new Date()) {
    return res.status(400).json({ error: "This reset link is invalid or has expired — request a new one." });
  }
  const hash = bcrypt.hashSync(password, 10);
  db.prepare("UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?").run(
    hash,
    row.id
  );
  res.json({ ok: true });
});

module.exports = router;
