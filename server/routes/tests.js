// Test series: MCQ quizzes attached to a course, auto-graded the moment a
// student submits, with an instant score + a leaderboard. Same
// enrolled_only/open_to_all access rule as live classes and videos (see
// services/access.js).

const express = require("express");
const db = require("../db");
const { requireRole } = require("../middleware/auth");
const { canAccess } = require("../services/access");

const router = express.Router();

function getCourseOr404(courseId, res) {
  const course = db.prepare("SELECT * FROM courses WHERE id = ?").get(courseId);
  if (!course) res.status(404).json({ error: "Course not found." });
  return course;
}

function getTestOr404(testId, res) {
  const test = db.prepare("SELECT * FROM tests WHERE id = ?").get(testId);
  if (!test) res.status(404).json({ error: "Test not found." });
  return test;
}

const OPTION_KEYS = ["a", "b", "c", "d"];

function validateQuestions(questions) {
  if (!Array.isArray(questions) || !questions.length) return "At least one question is required.";
  for (const [i, q] of questions.entries()) {
    if (!q.question_text || !String(q.question_text).trim()) return `Question ${i + 1} is missing its text.`;
    for (const key of OPTION_KEYS) {
      if (!q[`option_${key}`] || !String(q[`option_${key}`]).trim()) return `Question ${i + 1} is missing option ${key.toUpperCase()}.`;
    }
    if (!OPTION_KEYS.includes(q.correct_option)) return `Question ${i + 1}: correct_option must be a, b, c, or d.`;
  }
  return null;
}

// POST /api/courses/:courseId/tests  (teacher, own course)
// { title, description?, access_type?, questions: [{question_text, option_a..d, correct_option}] }
router.post("/courses/:courseId/tests", requireRole("teacher"), (req, res) => {
  const course = getCourseOr404(req.params.courseId, res);
  if (!course) return;
  if (course.teacher_id !== req.user.id) {
    return res.status(403).json({ error: "You can only add tests to your own courses." });
  }
  const { title, description, questions } = req.body;
  if (!title || !String(title).trim()) return res.status(400).json({ error: "Test title is required." });
  const questionsError = validateQuestions(questions);
  if (questionsError) return res.status(400).json({ error: questionsError });
  const accessType = req.body.access_type === "open_to_all" ? "open_to_all" : "enrolled_only";

  const testId = db.transaction(() => {
    const info = db
      .prepare("INSERT INTO tests (course_id, title, description, access_type) VALUES (?,?,?,?)")
      .run(course.id, title.trim(), description || null, accessType);
    const insertQ = db.prepare(
      `INSERT INTO test_questions (test_id, question_text, option_a, option_b, option_c, option_d, correct_option, order_num)
       VALUES (?,?,?,?,?,?,?,?)`
    );
    questions.forEach((q, i) => {
      insertQ.run(info.lastInsertRowid, q.question_text.trim(), q.option_a, q.option_b, q.option_c, q.option_d, q.correct_option, i);
    });
    return info.lastInsertRowid;
  })();

  res.json({ test: db.prepare("SELECT * FROM tests WHERE id = ?").get(testId), question_count: questions.length });
});

// GET /api/courses/:courseId/tests — list visible to this viewer, with
// question_count and (for a logged-in student) their best score so far.
router.get("/courses/:courseId/tests", (req, res) => {
  const course = getCourseOr404(req.params.courseId, res);
  if (!course) return;
  const rows = db
    .prepare(
      `SELECT t.*, COUNT(tq.id) AS question_count
       FROM tests t LEFT JOIN test_questions tq ON tq.test_id = t.id
       WHERE t.course_id = ? GROUP BY t.id ORDER BY t.created_at DESC`
    )
    .all(course.id);

  const visible = rows.filter((t) => canAccess({ courseId: course.id, accessType: t.access_type, teacherId: course.teacher_id }, req.user));

  const withAttempts = visible.map((t) => {
    if (req.user && req.user.role === "student") {
      const stats = db
        .prepare("SELECT MAX(score) AS best_score, COUNT(*) AS attempt_count FROM test_attempts WHERE test_id = ? AND student_id = ?")
        .get(t.id, req.user.id);
      return { ...t, best_score: stats.best_score, attempt_count: stats.attempt_count };
    }
    // Teacher (or a guest, for whom this field is meaningless): total
    // attempts by ALL students, not "my" attempts.
    const total = db.prepare("SELECT COUNT(*) AS n FROM test_attempts WHERE test_id = ?").get(t.id);
    return { ...t, best_score: null, attempt_count: total.n };
  });

  res.json({ tests: withAttempts });
});

// GET /api/tests/:id  (student, access-checked) — questions WITHOUT the
// correct answers, for taking the test.
router.get("/tests/:id", requireRole("student"), (req, res) => {
  const test = getTestOr404(req.params.id, res);
  if (!test) return;
  const course = db.prepare("SELECT * FROM courses WHERE id = ?").get(test.course_id);
  if (!canAccess({ courseId: test.course_id, accessType: test.access_type, teacherId: course.teacher_id }, req.user)) {
    return res.status(403).json({ error: "This test is only for students registered in this course." });
  }
  const questions = db
    .prepare("SELECT id, question_text, option_a, option_b, option_c, option_d FROM test_questions WHERE test_id = ? ORDER BY order_num ASC")
    .all(test.id);
  res.json({ test, questions });
});

// POST /api/tests/:id/attempt  (student)  { answers: [{question_id, selected_option}] }
// Grades server-side against test_questions.correct_option -- never trusts
// a score the client claims (same posture as coupon/payment verification
// elsewhere in this app).
router.post("/tests/:id/attempt", requireRole("student"), (req, res) => {
  const test = getTestOr404(req.params.id, res);
  if (!test) return;
  const course = db.prepare("SELECT * FROM courses WHERE id = ?").get(test.course_id);
  if (!canAccess({ courseId: test.course_id, accessType: test.access_type, teacherId: course.teacher_id }, req.user)) {
    return res.status(403).json({ error: "This test is only for students registered in this course." });
  }
  const questions = db.prepare("SELECT * FROM test_questions WHERE test_id = ?").all(test.id);
  if (!questions.length) return res.status(400).json({ error: "This test has no questions." });

  const submitted = new Map((req.body.answers || []).map((a) => [Number(a.question_id), a.selected_option]));

  const { attemptId, results, score } = db.transaction(() => {
    let score = 0;
    const results = [];
    const info = db.prepare("INSERT INTO test_attempts (test_id, student_id, score, total_questions) VALUES (?,?,0,?)").run(test.id, req.user.id, questions.length);
    const insertAnswer = db.prepare("INSERT INTO test_answers (attempt_id, question_id, selected_option, is_correct) VALUES (?,?,?,?)");
    for (const q of questions) {
      const selected = submitted.get(q.id) || null;
      const isCorrect = selected === q.correct_option;
      if (isCorrect) score++;
      insertAnswer.run(info.lastInsertRowid, q.id, selected, isCorrect ? 1 : 0);
      results.push({ question_id: q.id, selected_option: selected, correct_option: q.correct_option, is_correct: isCorrect });
    }
    db.prepare("UPDATE test_attempts SET score = ? WHERE id = ?").run(score, info.lastInsertRowid);
    return { attemptId: info.lastInsertRowid, results, score };
  })();

  res.json({ attempt_id: attemptId, score, total_questions: questions.length, results });
});

// GET /api/tests/:id/leaderboard — top 10 scores, student-facing (student
// must be able to see the test at all).
router.get("/tests/:id/leaderboard", requireRole("student"), (req, res) => {
  const test = getTestOr404(req.params.id, res);
  if (!test) return;
  const course = db.prepare("SELECT * FROM courses WHERE id = ?").get(test.course_id);
  if (!canAccess({ courseId: test.course_id, accessType: test.access_type, teacherId: course.teacher_id }, req.user)) {
    return res.status(403).json({ error: "This test is only for students registered in this course." });
  }
  const leaderboard = db
    .prepare(
      `SELECT u.name AS student_name, MAX(ta.score) AS best_score, ta.total_questions
       FROM test_attempts ta JOIN users u ON u.id = ta.student_id
       WHERE ta.test_id = ? GROUP BY ta.student_id ORDER BY best_score DESC, MIN(ta.completed_at) ASC LIMIT 10`
    )
    .all(test.id);
  res.json({ leaderboard });
});

// GET /api/tests/:id/attempts  (teacher, own course) — every attempt, for
// the teacher's own tracking (also what weekly parent reports read from).
router.get("/tests/:id/attempts", requireRole("teacher"), (req, res) => {
  const test = getTestOr404(req.params.id, res);
  if (!test) return;
  const course = db.prepare("SELECT * FROM courses WHERE id = ?").get(test.course_id);
  if (!course || course.teacher_id !== req.user.id) {
    return res.status(403).json({ error: "You can only view attempts for your own courses." });
  }
  const attempts = db
    .prepare(
      `SELECT ta.*, u.name AS student_name, u.phone AS student_phone
       FROM test_attempts ta JOIN users u ON u.id = ta.student_id
       WHERE ta.test_id = ? ORDER BY ta.completed_at DESC`
    )
    .all(test.id);
  res.json({ attempts });
});

module.exports = router;
