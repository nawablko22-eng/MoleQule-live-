// One-line analytics beacon — fires on page load and on opening a course,
// feeding the admin dashboard's "website visitors" / "course views" numbers.
// Fire-and-forget: a failed beacon should never block or error the page.
function trackEvent(eventType, courseId) {
  try {
    fetch("/api/analytics/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_type: eventType, course_id: courseId || null, path: location.pathname }),
      keepalive: true,
    }).catch(() => {});
  } catch { /* never block the page on analytics */ }
}
