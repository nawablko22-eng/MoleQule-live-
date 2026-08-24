// Weekly parent progress report -- a short WhatsApp summary of a
// student's activity in the last 7 days (classes attended + tests taken,
// with an average score), sent to the phone number the student added as
// their parent/guardian's contact (see PATCH /api/auth/me, parent_phone).
// A teacher can trigger one on demand ("Send now" -- routes/parentReports.js)
// or leave it to the weekly scheduler below.
//
// Same honesty caveat as services/cartReminders.js: this is a
// business-initiated WhatsApp message. Meta only delivers a free-form
// message like this one if the parent's number has messaged this
// WhatsApp Business number within the last 24 hours -- outside that
// window it needs a pre-approved message TEMPLATE instead, which this
// app doesn't set up (see README). A send outside the window fails with
// a clear error from Meta, which a manual "Send now" surfaces as-is, and
// which the automatic weekly poller logs and simply retries later.

const db = require("../db");
const whatsapp = require("./whatsapp");

const POLL_MS = 6 * 60 * 60 * 1000; // check a few times a day -- cheap, and keeps retries timely
const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;

function studentsWithParentPhone() {
  return db
    .prepare("SELECT id, name, parent_phone FROM users WHERE role = 'student' AND parent_phone IS NOT NULL AND parent_phone != ''")
    .all();
}

// Last 7 days of activity for one student -- the two things a parent
// actually wants to know: did they show up, and how did they do.
function buildStats(studentId) {
  const attendance = db
    .prepare(
      `SELECT COUNT(DISTINCT live_class_id) AS classes_attended
       FROM attendance WHERE student_id = ? AND joined_at >= datetime('now', '-7 days')`
    )
    .get(studentId);
  const tests = db
    .prepare(
      `SELECT COUNT(*) AS tests_taken, AVG(score * 100.0 / total_questions) AS avg_pct
       FROM test_attempts WHERE student_id = ? AND completed_at >= datetime('now', '-7 days')`
    )
    .get(studentId);
  return {
    classesAttended: attendance.classes_attended || 0,
    testsTaken: tests.tests_taken || 0,
    avgPct: tests.avg_pct === null ? null : Math.round(tests.avg_pct),
  };
}

function reportText(student, stats) {
  const lines = [
    `MoleQule Prep -- weekly update for ${student.name}`,
    `Classes attended this week: ${stats.classesAttended}`,
    stats.testsTaken > 0
      ? `Tests taken: ${stats.testsTaken} (average score: ${stats.avgPct}%)`
      : `Tests taken: 0`,
  ];
  return lines.join("\n");
}

// Sends one report right now and records it. Throws (with a message safe
// to show a teacher directly) if the student has no parent number, or if
// WhatsApp isn't connected, or if Meta's send itself fails.
async function sendReport(studentId) {
  const student = db.prepare("SELECT id, name, parent_phone FROM users WHERE id = ? AND role = 'student'").get(studentId);
  if (!student) throw new Error("Student not found.");
  if (!student.parent_phone) throw new Error("This student hasn't added a parent/guardian WhatsApp number yet.");
  if (!whatsapp.isConfigured()) throw new Error("WhatsApp isn't connected yet -- see .env.example (WHATSAPP_TOKEN/WHATSAPP_PHONE_NUMBER_ID).");

  const stats = buildStats(studentId);
  const text = reportText(student, stats);
  await whatsapp.sendMessage(student.parent_phone, text);

  db.prepare(
    `INSERT INTO parent_reports (student_id, sent_at) VALUES (?, datetime('now'))
     ON CONFLICT(student_id) DO UPDATE SET sent_at = excluded.sent_at`
  ).run(studentId);

  return { student, stats, text };
}

async function checkWeeklyReports() {
  if (!whatsapp.isConfigured()) return; // nothing to do until it's connected
  for (const student of studentsWithParentPhone()) {
    const last = db.prepare("SELECT sent_at FROM parent_reports WHERE student_id = ?").get(student.id);
    if (last) {
      const lastMs = Date.parse(last.sent_at.replace(" ", "T") + "Z"); // SQLite's datetime('now') format -> a real ISO string
      if (!Number.isNaN(lastMs) && Date.now() - lastMs < WEEKLY_MS) continue;
    }
    try {
      await sendReport(student.id);
      console.log(`[parentReports] weekly report sent for student ${student.id}`);
    } catch (err) {
      // Expected to fail for a parent who hasn't messaged our WhatsApp
      // number in the last 24h and we don't have an approved template --
      // logged and simply retried on a later poll, never blocks anyone else.
      console.error(`[parentReports] weekly send failed for student ${student.id}:`, err.message);
    }
  }
}

function start() {
  setInterval(() => {
    checkWeeklyReports().catch((err) => console.error("[parentReports] poll error:", err));
  }, POLL_MS);
}

module.exports = { start, sendReport, buildStats, reportText, checkWeeklyReports };
