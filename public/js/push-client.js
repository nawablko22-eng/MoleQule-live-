// Registers the service worker and subscribes the current student to
// push notifications. Call enablePush() from a click handler (browsers
// require a user gesture before granting notification permission).

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function enablePush(statusEl) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    if (statusEl) statusEl.textContent = "This browser doesn't support push notifications.";
    return false;
  }
  try {
    const { publicKey, configured } = await api("/push/public-key");
    if (!configured) {
      if (statusEl) statusEl.textContent = "Notifications aren't set up on the server yet (missing VAPID keys).";
      return false;
    }
    const reg = await navigator.serviceWorker.register("/sw.js");
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
    await api("/push/subscribe", { method: "POST", body: { subscription: sub.toJSON() } });
    if (statusEl) statusEl.textContent = "Notifications on — you'll get an alert the moment a live class starts.";
    return true;
  } catch (err) {
    if (statusEl) statusEl.textContent = "Couldn't enable notifications: " + err.message;
    return false;
  }
}
