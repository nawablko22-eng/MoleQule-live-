// Service worker: receives the push event even if no tab is open, and
// shows a native OS notification. Clicking it opens (or focuses) the
// live class's watch page.
self.addEventListener("push", (event) => {
  let data = { title: "MoleQule Prep", body: "You have a new update.", url: "/" };
  try { data = event.data.json(); } catch { /* plain-text fallback */ }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon.png",
      badge: "/icon.png",
      data: { url: data.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    clients.matchAll({ type: "window" }).then((all) => {
      const existing = all.find((c) => c.url.includes(url));
      if (existing) return existing.focus();
      return clients.openWindow(url);
    })
  );
});
