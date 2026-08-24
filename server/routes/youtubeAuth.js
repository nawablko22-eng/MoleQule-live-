// YouTube connection, entirely from the Settings page now (public/settings.html)
// instead of hand-editing .env + restarting the server:
//   1. POST /credentials saves the Client ID/Secret from Google Cloud
//      Console — takes effect immediately (see services/settings.js).
//   2. GET /oauth/start opens Google's consent screen for the channel
//      owner's Google account.
//   3. GET /oauth/callback saves the refresh token it gets back the same
//      way — the connection is live the moment this redirect lands, no
//      copy-pasting into .env and no restart.

const express = require("express");
const yt = require("../services/youtube");
const settings = require("../services/settings");
const { requireRole } = require("../middleware/auth");
const router = express.Router();

// POST /api/youtube/credentials  { client_id, client_secret }  (teacher)
router.post("/credentials", requireRole("teacher"), (req, res) => {
  const clientId = String(req.body.client_id || "").trim();
  const clientSecret = String(req.body.client_secret || "").trim();
  if (!clientId || !clientSecret) {
    return res.status(400).json({ error: "Both Client ID and Client Secret are required." });
  }
  settings.set("GOOGLE_CLIENT_ID", clientId);
  settings.set("GOOGLE_CLIENT_SECRET", clientSecret);
  res.json({ ok: true, has_credentials: yt.hasClientCredentials() });
});

router.get("/oauth/start", requireRole("teacher"), (req, res) => {
  if (!yt.hasClientCredentials()) {
    return res.redirect("/settings.html?need=youtube");
  }
  res.redirect(yt.getAuthUrl());
});

router.get("/oauth/callback", async (req, res) => {
  if (req.query.error) {
    return res.redirect(`/settings.html?youtube=error&message=${encodeURIComponent(req.query.error)}`);
  }
  try {
    const refreshToken = await yt.exchangeCodeForRefreshToken(req.query.code);
    if (!refreshToken) {
      // Google only issues a NEW refresh token on the first consent, or
      // when prompt=consent forces re-consent (which getAuthUrl() always
      // sets) -- this branch is just a safety net, shouldn't normally hit.
      return res.redirect("/settings.html?youtube=error&message=" + encodeURIComponent("Google didn't return a refresh token — try connecting again."));
    }
    settings.set("GOOGLE_REFRESH_TOKEN", refreshToken);
    res.redirect("/settings.html?youtube=connected");
  } catch (err) {
    res.redirect(`/settings.html?youtube=error&message=${encodeURIComponent(err.message)}`);
  }
});

router.get("/status", (req, res) => {
  res.json({
    configured: yt.isConfigured(),
    has_credentials: yt.hasClientCredentials(),
    redirect_uri: process.env.GOOGLE_REDIRECT_URI || "",
  });
});

module.exports = router;
