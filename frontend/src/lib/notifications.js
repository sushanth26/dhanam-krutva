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
  const subscription = support.push
    ? await syncExistingSubscription(registration, config, Notification.permission)
    : null;
  return {
    supported: true,
    permission: Notification.permission,
    webPushConfigured: Boolean(config.web_push_configured && config.vapid_public_key),
    vapidPublicKey: config.vapid_public_key,
    subscribed: Boolean(subscription),
  };
}

export async function enableNotifications(alertStrategies = {}) {
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
  const subscription = support.push ? await ensureServerSubscription(registration, config, null, alertStrategies) : null;

  return {
    supported: true,
    permission,
    webPushConfigured: Boolean(config.web_push_configured && config.vapid_public_key),
    subscribed: Boolean(subscription),
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

export async function setAppBadgeCount(count) {
  const badgeCount = Number(count) || 0;
  if (badgeCount > 0 && "setAppBadge" in navigator) {
    await navigator.setAppBadge(badgeCount);
    return true;
  }
  if (badgeCount <= 0 && "clearAppBadge" in navigator) {
    await navigator.clearAppBadge();
    return true;
  }
  return false;
}

export async function syncNotificationPreferences(alertStrategies = {}) {
  const support = notificationSupport();
  if (!support.notifications || !support.serviceWorker || !support.push || Notification.permission !== "granted") {
    return false;
  }
  const config = await getJson("/api/notifications/config");
  const registration = await registerNotificationWorker();
  const subscription = await ensureServerSubscription(registration, config, null, alertStrategies);
  return Boolean(subscription);
}

async function registerNotificationWorker() {
  const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: "/static/" });
  registration.update().catch(() => {});
  return registration;
}

async function syncExistingSubscription(registration, config, permission) {
  const existing = await registration.pushManager.getSubscription();
  if (permission !== "granted" || !config.web_push_configured || !config.vapid_public_key) {
    return existing;
  }
  return ensureServerSubscription(registration, config, existing);
}

async function ensureServerSubscription(registration, config, currentSubscription = null, alertStrategies = {}) {
  if (!config.web_push_configured || !config.vapid_public_key) return currentSubscription;
  if (currentSubscription && !subscriptionMatchesKey(currentSubscription, config.vapid_public_key)) {
    await currentSubscription.unsubscribe();
    currentSubscription = null;
  }
  const subscription = currentSubscription || await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(config.vapid_public_key),
  });
  await postJson("/api/notifications/subscribe", {
    subscription: subscription.toJSON(),
    alert_strategies: alertStrategies,
  });
  return subscription;
}

function subscriptionMatchesKey(subscription, vapidPublicKey) {
  const key = subscription.options?.applicationServerKey;
  if (!key) return true;
  return arrayBufferToUrlBase64(key) === vapidPublicKey;
}

function arrayBufferToUrlBase64(buffer) {
  const raw = String.fromCharCode(...new Uint8Array(buffer));
  return window.btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function urlBase64ToUint8Array(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}
