// Builds the promotional image + ad copy for a course. Two tiers, so
// "Advertise this course" produces something usable the moment you click
// it, no setup required:
//   - No OPENAI_API_KEY: a clean templated graphic — course title, price,
//     MoleQule Prep branding on a gradient background — rendered with
//     `sharp` (already a dependency here, used for video thumbnails).
//   - OPENAI_API_KEY set: a real AI-generated photo/illustration for the
//     course instead, via OpenAI's Images API.

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const OUT_DIR = path.join(__dirname, "..", "..", "uploads", "ad-creatives");
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function isAiConfigured() {
  return Boolean(process.env.OPENAI_API_KEY);
}

// Same 4-color rotation used for course cards elsewhere (public/home.html
// THUMB_STYLES) so the ad matches what students already recognize.
const GRADIENTS = [
  ["#0E7A5F", "#0A5C47"],
  ["#B9791C", "#8a5a12"],
  ["#2b6cb0", "#1a4971"],
  ["#6b46c1", "#4c2d92"],
];

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}

// Wraps `text` to roughly `maxChars` per line for the SVG template below
// (SVG has no built-in text wrapping).
function wrapText(text, maxChars) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > maxChars) { if (line) lines.push(line.trim()); line = w; }
    else line = (line + " " + w).trim();
  }
  if (line) lines.push(line.trim());
  return lines.slice(0, 3);
}

async function templateImage(course) {
  const [c1, c2] = GRADIENTS[course.id % GRADIENTS.length];
  const priceLine = course.price > 0 ? `₹${course.price}` : "FREE";
  const titleLines = wrapText(course.title, 22);
  const svg = `
    <svg width="1080" height="1080" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${c1}"/>
          <stop offset="100%" stop-color="${c2}"/>
        </linearGradient>
      </defs>
      <rect width="1080" height="1080" fill="url(#bg)"/>
      <circle cx="100" cy="88" r="9" fill="#ffffff" opacity="0.9"/>
      <text x="122" y="99" font-family="Arial, sans-serif" font-size="32" font-weight="700" fill="#ffffff">MoleQule Prep</text>
      <text x="90" y="${540 - titleLines.length * 35}" font-family="Arial, sans-serif" font-size="70" font-weight="800" fill="#ffffff">${titleLines.map((l, i) => `<tspan x="90" dy="${i === 0 ? 0 : 78}">${escapeXml(l)}</tspan>`).join("")}</text>
      <text x="90" y="920" font-family="Arial, sans-serif" font-size="58" font-weight="700" fill="#ffffff">${escapeXml(priceLine)}</text>
      <rect x="90" y="960" width="300" height="4" fill="#ffffff" opacity="0.6"/>
    </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function aiImage(course) {
  const prompt = `A bright, modern promotional graphic for an online chemistry coaching course called "${course.title}" for Indian NEET/JEE students. Clean, professional edtech advertisement style, chemistry/lab imagery (flasks, molecules), teal and gold color palette, no readable text in the image, square composition.`;
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: "gpt-image-1", prompt, size: "1024x1024" }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("OpenAI image generation: " + (data.error?.message || "failed"));
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI image generation returned no image data.");
  return Buffer.from(b64, "base64");
}

// Returns { publicPath, mode } — mode is 'ai' or 'template', useful for the
// UI to say which one it got. Falls back to the template silently if the
// AI call fails, so "Advertise this course" never just errors out.
async function generateImage(course) {
  let buffer, mode;
  if (isAiConfigured()) {
    try {
      buffer = await aiImage(course);
      mode = "ai";
    } catch (err) {
      console.error("[adCreative] AI image failed, falling back to template:", err.message);
    }
  }
  if (!buffer) {
    buffer = await templateImage(course);
    mode = "template";
  }
  const filename = `course-${course.id}-${Date.now()}.png`;
  fs.writeFileSync(path.join(OUT_DIR, filename), buffer);
  return { buffer, mode, publicPath: `/uploads/ad-creatives/${filename}` };
}

function adCopy(course) {
  const priceLine = course.price > 0 ? `Enroll for just ₹${course.price}.` : "Register free.";
  return `🧪 ${course.title} — MoleQule Prep\n${course.description || "Live classes, video library, and doubt-solving with YK Sir."}\n${priceLine} Limited seats, message us to know more.`;
}

module.exports = { isAiConfigured, generateImage, adCopy };
