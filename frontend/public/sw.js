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
  event.waitUntil(Promise.all([setBadgeFromPayload(payload), showNotification(payload)]));
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "SHOW_NOTIFICATION") return;
  const payload = event.data.payload || {};
  event.waitUntil(Promise.all([setBadgeFromPayload(payload), showNotification(payload)]));
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

function badgeCountFromPayload(payload) {
  const count = payload.badgeCount ?? payload.badge_count ?? payload.matches?.length ?? 0;
  return Number.isFinite(Number(count)) ? Number(count) : 0;
}

function setBadgeFromPayload(payload) {
  const count = badgeCountFromPayload(payload);
  if (count > 0 && "setAppBadge" in navigator) {
    return navigator.setAppBadge(count);
  }
  if (count <= 0 && "clearAppBadge" in navigator) {
    return navigator.clearAppBadge();
  }
  return Promise.resolve();
}

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
