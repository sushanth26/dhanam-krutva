import { useEffect, useMemo, useState } from "react";

import { unreadCount } from "../lib/appSelectors";
import {
  disableNotifications,
  enableNotifications,
  loadNotificationState,
  setAppBadgeCount,
  syncNotificationPreferences,
} from "../lib/notifications";

const MAX_NOTIFICATIONS = 20;

const INITIAL_NOTIFICATION_STATE = {
  supported: false,
  permission: "default",
  webPushConfigured: false,
  subscribed: false,
  appEnabled: true,
};

export function useAppNotifications({ setLiveAlert, setLoadingKey }) {
  const [notificationState, setNotificationState] = useState(INITIAL_NOTIFICATION_STATE);
  const [notifications, setNotifications] = useState([]);
  const unreadNotificationCount = useMemo(() => unreadCount(notifications), [notifications]);

  function addNotification({ title, message, kind = "update" }) {
    setNotifications((current) => [
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        title,
        message,
        kind,
        read: false,
        createdAt: new Date().toISOString(),
      },
      ...current,
    ].slice(0, MAX_NOTIFICATIONS));
  }

  function markNotificationsRead() {
    setNotifications((current) => current.map((item) => ({ ...item, read: true })));
  }

  async function enableAppNotifications() {
    setLoadingKey("notifications", true);
    try {
      const nextState = await enableNotifications();
      setNotificationState(nextState);
      if (nextState.permission === "granted") {
        addNotification({
          title: "Push notifications enabled",
          message: nextState.webPushConfigured && nextState.subscribed
            ? "Railway can send MTF push alerts."
            : "Device notifications are enabled. Add VAPID keys for closed-app push alerts.",
          kind: "system",
        });
      }
    } catch (error) {
      setLiveAlert(error.message);
    } finally {
      setLoadingKey("notifications", false);
    }
  }

  async function disableAppNotifications() {
    setLoadingKey("notifications", true);
    try {
      const nextState = await disableNotifications();
      setNotificationState((current) => ({ ...current, ...nextState }));
      addNotification({
        title: "Web notifications off",
        message: "This device will not receive app notifications until you turn them back on.",
        kind: "system",
      });
    } catch (error) {
      setLiveAlert(error.message);
    } finally {
      setLoadingKey("notifications", false);
    }
  }

  useEffect(() => {
    loadNotificationState()
      .then(setNotificationState)
      .catch(() => {
        setNotificationState((current) => ({ ...current, supported: false }));
      });
  }, []);

  useEffect(() => {
    const canBadge = notificationState.appEnabled && notificationState.permission === "granted";
    setAppBadgeCount(canBadge ? unreadNotificationCount : 0).catch(() => {});
  }, [notificationState.appEnabled, notificationState.permission, unreadNotificationCount]);

  useEffect(() => {
    if (!notificationState.appEnabled) return;
    syncNotificationPreferences().catch(() => {});
  }, [notificationState.appEnabled]);

  return {
    addNotification,
    disableAppNotifications,
    enableAppNotifications,
    markNotificationsRead,
    notifications,
    notificationState,
  };
}
