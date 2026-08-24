// "Continue with Google" sign-in for students/teachers — a completely
// different thing from services/youtube.js's OAuth, even though it can
// reuse the same GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET. That one is a
// single teacher granting permission to broadcast on THEIR channel
// (scope: youtube). This one is any student or teacher proving who they
// are with their own Google account (scope: just email + profile, read
// -only, nothing YouTube-related) — a normal "Sign in with Google" button,
// and anyone can use it, not just the channel owner.

const { google } = require("googleapis");

function redirectUri() {
  return (
    process.env.GOOGLE_LOGIN_REDIRECT_URI ||
    `${process.env.BASE_URL || "http://localhost:4000"}/api/auth/google/callback`
  );
}

function client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri()
  );
}

// Same two env vars as the YouTube integration — if a teacher already set
// those up for live streaming, "Continue with Google" starts working too
// (as long as the login redirect URI is also added in Google Cloud
// Console; see README).
function isConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

// `state` carries the intended role (for a brand-new signup only — an
// existing account keeps its real role) and where to return to,
// round-tripped through Google since nothing else about this request
// survives the redirect.
function getAuthUrl(state) {
  return client().generateAuthUrl({
    access_type: "online",
    scope: ["openid", "email", "profile"],
    state,
  });
}

// Exchanges the one-time code Google sent back for the signed-in
// person's basic profile — just enough to identify/create an account,
// nothing about their YouTube channel or any other Google data.
async function getProfile(code) {
  const oauth2Client = client();
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
  const { data } = await oauth2.userinfo.get();
  return { googleId: data.id, email: data.email, name: data.name };
}

module.exports = { isConfigured, getAuthUrl, getProfile };
