// Public, unauthenticated content for the home page: the YouTube Shorts
// folder and the social "connect" buttons. Nothing here needs a login —
// visitors browsing before they register should see all of it.

const express = require("express");
const shorts = require("../services/youtubeShorts");

const router = express.Router();

// GET /api/shorts — the home page's Shorts folder contents. When a new
// video is uploaded as a Short on your channel, it appears here on its
// own (next cache refresh, within 10 minutes) — nothing to re-upload or
// sync by hand.
router.get("/shorts", async (req, res) => {
  if (!shorts.isConfigured()) {
    return res.json({ configured: false, shorts: [] });
  }
  try {
    const items = await shorts.fetchShorts();
    res.json({ configured: true, shorts: items });
  } catch (err) {
    console.error("[shorts] fetch failed:", err.message);
    res.status(502).json({ configured: true, shorts: [], error: "Could not reach YouTube right now." });
  }
});

// GET /api/social — links for the home page's connect buttons, set by
// whoever deployed this instance (see .env.example). whatsapp/telegram
// here are just the public "chat with us" links (wa.me / t.me) — separate
// from the WHATSAPP_TOKEN/TELEGRAM_BOT_TOKEN credentials that power the
// actual send/receive API (see services/whatsapp.js, services/telegram.js).
router.get("/social", (req, res) => {
  res.json({
    instagram: process.env.INSTAGRAM_URL || null,
    facebook: process.env.FACEBOOK_URL || null,
    whatsapp: process.env.WHATSAPP_DISPLAY_NUMBER ? `https://wa.me/${process.env.WHATSAPP_DISPLAY_NUMBER}` : null,
    telegram_bot: process.env.TELEGRAM_BOT_USERNAME || null,
  });
});

module.exports = router;
