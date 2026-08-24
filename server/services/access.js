// Single source of truth for the "registered vs everyone" rule, used by
// both the live-class watch endpoint and the video library endpoint so
// the two can never drift apart.
//
//   enrolled_only -> true only for a logged-in student registered
//                    (enrolled) in that specific course. The course's
//                    teacher can always access their own content.
//   open_to_all   -> true for anyone — a logged-in enrolled student,
//                    a logged-in student who never bought the course,
//                    or a fully anonymous/non-registered visitor.

const db = require("../db");

// SQLite's datetime('now') columns come back as "YYYY-MM-DD HH:MM:SS"
// with no timezone marker -- Date.parse needs the "T"/"Z" to read it as
// the UTC instant it actually is (same conversion used in
// public/js/api.js's timeAgo() and services/cartReminders.js).
function isExpired(expiresAt) {
  if (!expiresAt) return false; // NULL = lifetime access, never expires
  return new Date(expiresAt.replace(" ", "T") + "Z") < new Date();
}

// The student's enrollment row for this course, or null if they never
// registered. Exposed (not just isEnrolled's boolean) so callers like
// routes/courses.js can tell "never enrolled" apart from "enrolled, but
// access has expired" and show the right thing (a plain "Register" vs.
// "Your access expired on <date> — renew below").
function getEnrollment(courseId, studentId) {
  if (!studentId) return null;
  return db.prepare("SELECT * FROM enrollments WHERE course_id = ? AND student_id = ?").get(courseId, studentId);
}

function isEnrolled(courseId, studentId) {
  const enrollment = getEnrollment(courseId, studentId);
  return !!enrollment && !isExpired(enrollment.expires_at);
}

function canAccess({ courseId, accessType, teacherId }, user) {
  if (user && user.role === "teacher" && user.id === teacherId) return true;
  if (accessType === "open_to_all") return true;
  if (accessType === "enrolled_only") {
    return !!user && user.role === "student" && isEnrolled(courseId, user.id);
  }
  return false;
}

module.exports = { canAccess, isEnrolled, getEnrollment, isExpired };
