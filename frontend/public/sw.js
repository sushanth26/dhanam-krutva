self.addEventListener("push", (event) => {
  const fallback = {
    title: "MTFs changed",
    body: "Open Dhanam Krutva to review the latest MTF table.",
    tag: "mtf-update",
    url: "/",
  };
  let payload = fallback;
  if (event.data) {
    try {
      payload = { ...fallback, ...event.data.json() };
    } catch {
      payload = { ...fallback, body: event.data.text() };
    }
  }
  event.waitUntil(showNotification(payload));
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "SHOW_NOTIFICATION") return;
  event.waitUntil(showNotification(event.data.payload || {}));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((client) => client.url === targetUrl);
      if (existing) return existing.focus();
      return self.clients.openWindow(targetUrl);
    }),
  );
});

function showNotification(payload) {
  return self.registration.showNotification(payload.title || "MTFs changed", {
    body: payload.body || "Open Dhanam Krutva to review the latest MTF table.",
    badge: "/static/icon.svg",
    icon: "/static/icon.svg",
    tag: payload.tag || "mtf-update",
    renotify: true,
    data: { url: payload.url || "/" },
  });
}
