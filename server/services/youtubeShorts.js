// Powers the home page's "Shorts" folder. Deliberately separate from
// server/services/youtube.js: that file needs OAuth (it broadcasts ON
// your behalf), but reading a channel's own public uploads is public
// data — a plain API key is enough, so this never touches the refresh
// token or the live-streaming scopes.
//
// There's no "give me only Shorts" endpoint in the YouTube Data API, so
// this fetches the channel's recent uploads and applies the same rule
// YouTube itself uses to call something a Short: vertical-friendly and
// at most ~3 minutes (183s, YouTube's 2024 Shorts length cap — this also
// safely includes the classic 60s Shorts).

const { google } = require("googleapis");

const SHORTS_MAX_SECONDS = 183;
const CACHE_MS = 10 * 60 * 1000; // 10 min — keeps this well under the API's free daily quota
let cache = { data: null, expiresAt: 0 };

function isConfigured() {
  return Boolean(process.env.YOUTUBE_API_KEY && process.env.YOUTUBE_CHANNEL_ID);
}

function youtube() {
  return google.youtube({ version: "v3", auth: process.env.YOUTUBE_API_KEY });
}

function parseISODuration(iso) {
  const m = String(iso || "").match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  const [, h, mnt, s] = m;
  return (Number(h) || 0) * 3600 + (Number(mnt) || 0) * 60 + (Number(s) || 0);
}

async function resolveChannelId(yt) {
  const raw = process.env.YOUTUBE_CHANNEL_ID.trim();
  if (/^UC[\w-]{20,}$/.test(raw)) return raw; // already a real channel ID
  const handle = raw.startsWith("@") ? raw : `@${raw}`;
  const res = await yt.channels.list({ part: ["id"], forHandle: handle });
  return res.data.items?.[0]?.id || null;
}

async function fetchShorts({ force = false } = {}) {
  if (!isConfigured()) return [];
  if (!force && cache.data && Date.now() < cache.expiresAt) return cache.data;

  const yt = youtube();
  const channelId = await resolveChannelId(yt);
  if (!channelId) return [];

  const channelRes = await yt.channels.list({ part: ["contentDetails"], id: [channelId] });
  const uploadsPlaylistId = channelRes.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) return [];

  const itemsRes = await yt.playlistItems.list({
    part: ["contentDetails"],
    playlistId: uploadsPlaylistId,
    maxResults: 50,
  });
  const videoIds = (itemsRes.data.items || []).map((i) => i.contentDetails.videoId).filter(Boolean);
  if (!videoIds.length) {
    cache = { data: [], expiresAt: Date.now() + CACHE_MS };
    return [];
  }

  const videosRes = await yt.videos.list({ part: ["snippet", "contentDetails"], id: videoIds });
  const shorts = (videosRes.data.items || [])
    .map((v) => ({
      id: v.id,
      title: v.snippet.title,
      thumbnail:
        v.snippet.thumbnails?.high?.url ||
        v.snippet.thumbnails?.medium?.url ||
        v.snippet.thumbnails?.default?.url,
      publishedAt: v.snippet.publishedAt,
      durationSeconds: parseISODuration(v.contentDetails.duration),
    }))
    .filter((v) => v.durationSeconds > 0 && v.durationSeconds <= SHORTS_MAX_SECONDS)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, 24);

  cache = { data: shorts, expiresAt: Date.now() + CACHE_MS };
  return shorts;
}

module.exports = { isConfigured, fetchShorts };
