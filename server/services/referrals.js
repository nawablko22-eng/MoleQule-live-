// Referral codes + the reward for using one. Every user gets a permanent
// code at signup (routes/auth.js). When someone NEW signs up with that
// code, both people get a personal, single-use discount coupon — see
// routes/auth.js register, which calls rewardReferral() below.

const db = require("../db");

const REFERRAL_DISCOUNT_PERCENT = 10; // both sides get 10% off their next purchase
const REFERRAL_COUPON_VALID_DAYS = 90;

function randomCode(length = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I — easy to read/share
  let out = "";
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function generateUniqueReferralCode() {
  let code;
  do {
    code = randomCode(6);
  } while (db.prepare("SELECT 1 FROM users WHERE referral_code = ?").get(code));
  return code;
}

function generateUniqueCouponCode(prefix) {
  let code;
  do {
    code = `${prefix}-${randomCode(5)}`;
  } while (db.prepare("SELECT 1 FROM coupons WHERE code = ?").get(code));
  return code;
}

// Creates the referrals row plus one coupon for each side. Nowhere near a
// financial system — this is a courtesy code, not a ledger — so it's kept
// as simple as it can be while still being genuinely usable at checkout.
function rewardReferral(referrerId, referredId) {
  db.prepare("INSERT INTO referrals (referrer_id, referred_id) VALUES (?,?)").run(referrerId, referredId);

  const expiresAt = new Date(Date.now() + REFERRAL_COUPON_VALID_DAYS * 24 * 3600 * 1000).toISOString();
  const insertCoupon = db.prepare(
    `INSERT INTO coupons (code, discount_percent, max_uses, expires_at, source, owner_student_id)
     VALUES (?,?,1,?, 'referral', ?)`
  );

  const referrerCoupon = generateUniqueCouponCode("THANKS");
  insertCoupon.run(referrerCoupon, REFERRAL_DISCOUNT_PERCENT, expiresAt, referrerId);

  const referredCoupon = generateUniqueCouponCode("WELCOME");
  insertCoupon.run(referredCoupon, REFERRAL_DISCOUNT_PERCENT, expiresAt, referredId);

  return { referrerCoupon, referredCoupon, discountPercent: REFERRAL_DISCOUNT_PERCENT };
}

module.exports = { generateUniqueReferralCode, rewardReferral, REFERRAL_DISCOUNT_PERCENT };
