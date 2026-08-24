const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const db = require("../db");
const { requireRole } = require("../middleware/auth");
const { canAccess } = require("../services/access");

const router = express.Router();

const uploadRoot = path.join(__dirname, "..", "..", "uploads");
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const sub = file.fieldname === "pdf" ? "pdfs" : "thumbnails";
    cb(null, path.join(uploadRoot, sub));
  },
  filename: (req, file, cb) => {
    const safe = Date.now() + "-" + file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, safe);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB, generous for lecture PDFs
  fileFilter: (req, file, cb) => {
    if (file.fieldname === "pdf" && file.mimetype !== "application/pdf") {
      return cb(new Error("pdf field must be a PDF file."));
    }
    if (file.fieldname === "thumbnail" && !file.mimetype.startsWith("image/")) {
      return cb(new Error("thumbnail field must be an image."));
    }
    cb(null, true);
  },
});

function getCourseOr404(courseId, res) {
  const course = db.prepare("SELECT * FROM courses WHERE id = ?").get(courseId);
  if (!course) res.status(404).json({ error: "Course not found." });
  return course;
}

function nextVideoNumber(courseId) {
  const row = db
    .prepare("SELECT COALESCE(MAX(video_number), 0) AS n FROM videos WHERE course_id = ?")
    .get(courseId);
  return row.n + 1;
}

// GET /api/courses/:courseId/videos — the course's content library,
// numbered, thumbnailed, filtered by what this viewer can access.
router.get("/courses/:courseId/videos", (req, res) => {
  const course = getCourseOr404(req.params.courseId, res);
  if (!course) return;
  const rows = db
    .prepare("SELECT * FROM videos WHERE course_id = ? ORDER BY video_number ASC")
    .all(course.id);
  const visible = rows.filter((v) =>
    canAccess({ courseId: course.id, accessType: v.access_type, teacherId: course.teacher_id }, req.user)
  );
  res.json({ videos: visible });
});

// POST /api/courses/:courseId/videos (teacher) — add a video entry by
// hand (e.g. one you edited outside the live-class flow). Live-class
// recordings are normally inserted automatically by
// server/services/youtubeSync.js once YouTube finishes archiving them.
router.post("/courses/:courseId/videos", requireRole("teacher"), upload.fields([
  { name: "thumbnail", maxCount: 1 },
  { name: "pdf", maxCount: 1 },
]), (req, res) => {
  const course = getCourseOr404(req.params.courseId, res);
  if (!course) return;
  if (course.teacher_id !== req.user.id) {
    return res.status(403).json({ error: "You can only add videos to your own courses." });
  }
  const { title, youtube_video_id, access_type } = req.body;
  if (!title || !youtube_video_id) {
    return res.status(400).json({ error: "title and youtube_video_id are required." });
  }
  const thumbFile = req.files?.thumbnail?.[0];
  const pdfFile = req.files?.pdf?.[0];
  const videoNumber = nextVideoNumber(course.id);

  const info = db
    .prepare(
      `INSERT INTO videos (course_id, title, video_number, youtube_video_id, thumbnail_path, pdf_path, access_type)
       VALUES (?,?,?,?,?,?,?)`
    )
    .run(
      course.id,
      title,
      videoNumber,
      youtube_video_id,
      thumbFile ? `/uploads/thumbnails/${thumbFile.filename}` : null,
      pdfFile ? `/uploads/pdfs/${pdfFile.filename}` : null,
      access_type === "open_to_all" ? "open_to_all" : "enrolled_only"
    );
  res.json({ video: db.prepare("SELECT * FROM videos WHERE id = ?").get(info.lastInsertRowid) });
});

// PATCH /api/videos/:id (teacher) — attach/replace a PDF and/or a custom
// thumbnail on an existing entry (including ones auto-created from a
// live class), or move it to a different position with video_number.
router.patch("/videos/:id", requireRole("teacher"), upload.fields([
  { name: "thumbnail", maxCount: 1 },
  { name: "pdf", maxCount: 1 },
]), (req, res) => {
  const video = db.prepare("SELECT * FROM videos WHERE id = ?").get(req.params.id);
  if (!video) return res.status(404).json({ error: "Video not found." });
  const course = db.prepare("SELECT * FROM courses WHERE id = ?").get(video.course_id);
  if (course.teacher_id !== req.user.id) {
    return res.status(403).json({ error: "You can only edit videos in your own courses." });
  }

  const thumbFile = req.files?.thumbnail?.[0];
  const pdfFile = req.files?.pdf?.[0];
  const title = req.body.title ?? video.title;
  const videoNumber = req.body.video_number ? Number(req.body.video_number) : video.video_number;
  const accessType = req.body.access_type
    ? (req.body.access_type === "open_to_all" ? "open_to_all" : "enrolled_only")
    : video.access_type;

  if (thumbFile && video.thumbnail_path?.startsWith("/uploads/")) {
    fs.rm(path.join(uploadRoot, "..", video.thumbnail_path), { force: true }, () => {});
  }
  if (pdfFile && video.pdf_path) {
    fs.rm(path.join(uploadRoot, "..", video.pdf_path), { force: true }, () => {});
  }

  db.prepare(
    `UPDATE videos SET title = ?, video_number = ?, access_type = ?,
       thumbnail_path = COALESCE(?, thumbnail_path),
       pdf_path = COALESCE(?, pdf_path)
     WHERE id = ?`
  ).run(
    title,
    videoNumber,
    accessType,
    thumbFile ? `/uploads/thumbnails/${thumbFile.filename}` : null,
    pdfFile ? `/uploads/pdfs/${pdfFile.filename}` : null,
    video.id
  );

  res.json({ video: db.prepare("SELECT * FROM videos WHERE id = ?").get(video.id) });
});

// GET /api/videos/:id/pdf — access-checked download (PDFs are NOT served
// as static files precisely so enrolled_only notes can't be guessed at
// via URL by a non-registered visitor).
router.get("/videos/:id/pdf", (req, res) => {
  const video = db.prepare("SELECT * FROM videos WHERE id = ?").get(req.params.id);
  if (!video || !video.pdf_path) return res.status(404).json({ error: "No PDF attached to this video." });
  const course = db.prepare("SELECT * FROM courses WHERE id = ?").get(video.course_id);
  const allowed = canAccess(
    { courseId: video.course_id, accessType: video.access_type, teacherId: course.teacher_id },
    req.user
  );
  if (!allowed) return res.status(403).json({ error: "You don't have access to this course's notes." });
  res.sendFile(path.join(uploadRoot, "..", video.pdf_path));
});

module.exports = router;
