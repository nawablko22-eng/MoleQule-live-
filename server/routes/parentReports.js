// Manual "send now" trigger for a parent's weekly progress report. The
// automatic weekly send lives in services/parentReports.js -- this route
// is just a teacher-facing button for "send one right now" (e.g. right
// before a parent-teacher call).

const express = require("express");
const db = require("../db");
const { requireRole } = require("../middleware/auth");
const parentReports = require("../services/parentReports");

const router = express.Router();

// POST /api/students/:id/parent-report/send  (teacher, only for a
// student registered in one of their own courses)
router.post("/students/:id/parent-report/send", requireRole("teacher"), async (req, res) => {
  const studentId = Number(req.params.id);
  const owns = db
    .prepare(
      `SELECT 1 FROM enrollments e JOIN courses c ON c.id = e.course_id
       WHERE e.student_id = ? AND c.teacher_id = ? LIMIT 1`
    )
    .get(studentId, req.user.id);
  if (!owns) return res.status(403).json({ error: "This student isn't registered in any of your courses." });

  try {
    const { stats, text } = await parentReports.sendReport(studentId);
    res.json({ ok: true, stats, message_preview: text });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
