import { getJson, postJson } from "./api";

const SERVICE_WORKER_URL = "/static/sw.js";

export function notificationSupport() {
  return {
    notifications: "Notification" in window,
    serviceWorker: "serviceWorker" in navigator,
    push: "PushManager" in window,
  };
}

export async function loadNotificationState() {
  const support = notificationSupport();
  if (!support.notifications || !support.serviceWorker) {
    return { supported: false, permission: "unsupported", webPushConfigured: false, subscribed: false };
  }

  const config = await getJson("/api/notifications/config");
  const registration = await registerNotificationWorker();
  const subscription = support.push ? await registration.pushManager.getSubscription() : null;
  return {
    supported: true,
    permission: Notification.permission,
    webPushConfigured: Boolean(config.web_push_configured && config.vapid_public_key),
    vapidPublicKey: config.vapid_public_key,
    subscribed: Boolean(subscription),
  };
}

export async function enableNotifications() {
  const support = notificationSupport();
  if (!support.notifications || !support.serviceWorker) {
    throw new Error("This browser does not support app notifications.");
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { supported: true, permission, webPushConfigured: false, subscribed: false };
  }

  const config = await getJson("/api/notifications/config");
  const registration = await registerNotificationWorker();
  let subscribed = false;
  if (support.push && config.web_push_configured && config.vapid_public_key) {
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.vapid_public_key),
      });
    }
    await postJson("/api/notifications/subscribe", { subscription: subscription.toJSON() });
    subscribed = true;
  }

  return {
    supported: true,
    permission,
    webPushConfigured: Boolean(config.web_push_configured && config.vapid_public_key),
    subscribed,
  };
}

export async function showDeviceNotification(payload) {
  if (!("Notification" in window) || Notification.permission !== "granted") return false;
  const registration = await registerNotificationWorker();
  if (registration.active) {
    registration.active.postMessage({ type: "SHOW_NOTIFICATION", payload });
    return true;
  }
  await registration.showNotification(payload.title || "MTFs changed", {
    body: payload.body || "Open Dhanam Krutva to review the latest MTF table.",
    icon: "/static/icon.svg",
    tag: payload.tag || "mtf-update",
    renotify: true,
    data: { url: payload.url || "/" },
  });
  return true;
}

export async function sendTestPush() {
  return postJson("/api/notifications/test", {});
}

async function registerNotificationWorker() {
  return navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: "/static/" });
}

function urlBase64ToUint8Array(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}
