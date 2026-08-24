// Wraps the two Google APIs we need:
//   - YouTube Live Streaming API  -> create the broadcast + stream, get a
//     stream key the teacher pastes into OBS (or a browser encoder), and
//     flip the broadcast through testing -> live -> complete.
//   - YouTube Data API v3          -> once a broadcast finishes, YouTube
//     archives the recording as a normal video on the channel; we read
//     its id/thumbnail back so it can become a `videos` row automatically.
//
// Requires a Google Cloud project with both APIs enabled and an OAuth
// client (see README). The Client ID/Secret and the refresh token earned
// by the one-time consent flow below are read through services/settings —
// entered from the Settings page (public/settings.html), they take effect
// immediately, no .env edit or server restart needed. GOOGLE_REDIRECT_URI
// stays a plain .env value: it's a fixed URL tied to your deployment
// domain and to what's registered in Google Cloud Console, not something
// you'd re-enter per connection attempt.

const { google } = require("googleapis");
const settings = require("./settings");

function getOAuthClient() {
  const client = new google.auth.OAuth2(
    settings.get("GOOGLE_CLIENT_ID"),
    settings.get("GOOGLE_CLIENT_SECRET"),
    process.env.GOOGLE_REDIRECT_URI
  );
  const refreshToken = settings.get("GOOGLE_REFRESH_TOKEN");
  if (refreshToken) {
    client.setCredentials({ refresh_token: refreshToken });
  }
  return client;
}

function hasClientCredentials() {
  return settings.has("GOOGLE_CLIENT_ID") && settings.has("GOOGLE_CLIENT_SECRET");
}

function isConfigured() {
  return hasClientCredentials() && settings.has("GOOGLE_REFRESH_TOKEN");
}

function youtube() {
  return google.youtube({ version: "v3", auth: getOAuthClient() });
}

// One-time consent URL a teacher opens in a browser to grant this app
// permission to broadcast on their YouTube channel.
function getAuthUrl() {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/youtube",
      "https://www.googleapis.com/auth/youtube.force-ssl",
    ],
  });
}

async function exchangeCodeForRefreshToken(code) {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  return tokens.refresh_token; // save this into .env as GOOGLE_REFRESH_TOKEN
}

// Creates the broadcast (the "event") + the stream (the ingestion
// endpoint), binds them together, and returns everything the teacher's
// encoder / browser needs to go live.
//
// privacyStatus is the actual YouTube-side visibility of the broadcast —
// a SEPARATE decision from our own app's access_type (which is what
// actually decides who in this app is allowed to see the link/embed and
// get notified). The two default sensibly together but the teacher can
// pick either explicitly:
//   'private'  -> only Google accounts YOU individually invite on
//                 YouTube can watch, even with the link. Not practical
//                 for a class roster of many students — use only if you
//                 plan to add each student's Google account by hand.
//   'unlisted' -> not searchable on YouTube, but anyone with the link/
//                 embed can watch. This is what actually makes
//                 "enrolled_only" work at class size: OUR app is the
//                 gatekeeper (a non-enrolled student is simply never
//                 given the link), not YouTube's own permission system.
//   'public'   -> listed and searchable on YouTube itself, on top of
//                 whatever this app does. Typical for "open_to_all"
//                 demo/promo classes you also want discoverable.
async function createBroadcastForLiveClass({ title, description, scheduledStartTime, accessType, privacyStatus }) {
  const yt = youtube();
  const resolvedPrivacy =
    privacyStatus || (accessType === "open_to_all" ? "public" : "unlisted");

  const broadcastRes = await yt.liveBroadcasts.insert({
    part: ["snippet", "contentDetails", "status"],
    requestBody: {
      snippet: {
        title,
        description: description || "",
        scheduledStartTime: scheduledStartTime || new Date().toISOString(),
      },
      contentDetails: {
        enableAutoStart: true,
        enableAutoStop: true,
        enableDvr: true,
        recordFromStart: true,
      },
      status: {
        privacyStatus: resolvedPrivacy,
        selfDeclaredMadeForKids: false,
      },
    },
  });

  const streamRes = await yt.liveStreams.insert({
    part: ["snippet", "cdn", "contentDetails"],
    requestBody: {
      snippet: { title: `${title} - stream` },
      cdn: {
        frameRate: "variable",
        ingestionType: "rtmp",
        resolution: "variable",
      },
    },
  });

  await yt.liveBroadcasts.bind({
    id: broadcastRes.data.id,
    part: ["id"],
    streamId: streamRes.data.id,
  });

  const ingestion = streamRes.data.cdn.ingestionInfo;

  return {
    broadcastId: broadcastRes.data.id,
    streamId: streamRes.data.id,
    streamKey: ingestion.streamName,
    ingestionUrl: ingestion.ingestionAddress,
    watchUrl: `https://www.youtube.com/watch?v=${broadcastRes.data.id}`,
    // One click from here drops the teacher straight into YouTube's own
    // live control room for THIS broadcast — camera/mic go-live, stream
    // health, live chat moderation, everything YouTube Studio offers.
    // No copy-pasting a stream key into OBS is required if they go live
    // this way instead (YouTube Studio can stream straight from a
    // webcam in the browser).
    studioUrl: `https://studio.youtube.com/video/${broadcastRes.data.id}/livestreaming`,
    privacyStatus: resolvedPrivacy,
  };
}

// Used by youtubeSync's poller to detect scheduled->live and live->complete
// transitions (lifeCycleStatus: 'created'|'ready'|'testing'|'live'|'complete'|'revoked').
async function getBroadcastLifecycle(broadcastId) {
  const yt = youtube();
  const res = await yt.liveBroadcasts.list({ part: ["status"], id: [broadcastId] });
  return res.data.items?.[0]?.status?.lifeCycleStatus || null;
}

// Manual override if enableAutoStart/Stop isn't used (e.g. testing).
async function transitionBroadcast(broadcastId, status) {
  const yt = youtube();
  await yt.liveBroadcasts.transition({
    id: broadcastId,
    broadcastStatus: status, // 'testing' | 'live' | 'complete'
    part: ["id", "status"],
  });
}

// After a broadcast ends, YouTube needs a little time to process the
// recording. This returns the video's current lifecycle status plus
// (once ready) its title/thumbnail — used by youtubeSync's poller.
async function getVideoStatus(videoId) {
  const yt = youtube();
  const res = await yt.videos.list({
    part: ["status", "snippet", "processingDetails"],
    id: [videoId],
  });
  const video = res.data.items?.[0];
  if (!video) return null;
  return {
    uploadStatus: video.status.uploadStatus, // 'uploaded' | 'processed' | ...
    processingStatus: video.processingDetails?.processingStatus, // 'processing' | 'succeeded' | ...
    title: video.snippet.title,
    thumbnail:
      video.snippet.thumbnails?.high?.url ||
      video.snippet.thumbnails?.medium?.url ||
      video.snippet.thumbnails?.default?.url,
  };
}

module.exports = {
  isConfigured,
  hasClientCredentials,
  getAuthUrl,
  exchangeCodeForRefreshToken,
  createBroadcastForLiveClass,
  transitionBroadcast,
  getBroadcastLifecycle,
  getVideoStatus,
};
