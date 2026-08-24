// "Advertise this course" — one button, two outcomes depending on setup:
//   - Meta Ads connected (see services/metaAds.js): generates the creative
//     and creates a real, paused Lead Generation campaign, ready to review
//     and activate.
//   - Not connected: generates the same creative + ad copy as a preview,
//     so there's always something useful the moment you click it — copy it
//     into Ads Manager by hand, or connect real credentials later (README).

const express = require("express");
const db = require("../db");
const { requireRole } = require("../middleware/auth");
const adCreative = require("../services/adCreative");
const metaAds = require("../services/metaAds");

const router = express.Router();

function ownedCourse(req) {
  return db.prepare("SELECT * FROM courses WHERE id = ? AND teacher_id = ?").get(req.params.id, req.user.id);
}

// POST /api/courses/:id/advertise — generates the creative, and if Meta
// Ads is configured, creates the paused campaign too.
router.post("/courses/:id/advertise", requireRole("teacher"), async (req, res) => {
  const course = ownedCourse(req);
  if (!course) return res.status(404).json({ error: "Course not found." });

  let image;
  try {
    image = await adCreative.generateImage(course);
  } catch (err) {
    return res.status(502).json({ error: "Couldn't generate the ad image: " + err.message });
  }
  const copy = adCreative.adCopy(course);
  const courseUrl = `${process.env.BASE_URL || ""}/home.html?course=${course.id}`;

  if (!metaAds.isConfigured()) {
    return res.json({
      mode: "preview",
      image: image.publicPath,
      image_mode: image.mode,
      ad_copy: copy,
      message: "Meta Ads isn't connected yet (see README) — download this image and copy the text into Ads Manager yourself, or add Meta Ads credentials to publish with one click next time.",
      manage_url: "https://adsmanager.facebook.com/",
    });
  }

  try {
    const campaign = await metaAds.createLeadCampaign(course, image.buffer, copy, courseUrl);
    res.json({
      mode: "meta",
      image: image.publicPath,
      image_mode: image.mode,
      ad_copy: copy,
      campaign,
      message: "Draft campaign created on Meta (paused). Review the creative below, then hit \"Go live\" when you're ready to spend.",
    });
  } catch (err) {
    res.status(502).json({
      error: "Creative was generated, but creating the Meta campaign failed: " + err.message,
      image: image.publicPath,
      ad_copy: copy,
    });
  }
});

// POST /api/courses/:id/advertise/activate  { campaign_id } — the explicit
// "go live" step; only does anything once Meta Ads is actually connected.
router.post("/courses/:id/advertise/activate", requireRole("teacher"), async (req, res) => {
  const course = ownedCourse(req);
  if (!course) return res.status(404).json({ error: "Course not found." });
  if (!metaAds.isConfigured()) return res.status(409).json({ error: "Meta Ads isn't connected — see README." });
  if (!req.body.campaign_id) return res.status(400).json({ error: "Missing campaign_id." });

  try {
    await metaAds.activateCampaign(req.body.campaign_id);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
