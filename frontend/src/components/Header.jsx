import { useState } from "react";

import { findAccountId } from "../lib/market";

export function Header({
  status,
  accounts,
  selectedAccountId,
  liveRefreshActive,
  onRefresh,
  onStart,
  onStop,
  onSelectAccount,
  notificationState,
  onEnableNotifications,
  notifications,
  onMarkNotificationsRead,
}) {
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const notificationLabel = notificationButtonLabel(notificationState);
  const environmentText = status ? `${status.environment.toUpperCase()} / ${status.region.toUpperCase()}` : "-";
  const unreadCount = notifications.filter((item) => !item.read).length;
  const pushEnabled = notificationState.permission === "granted";
  return (
    <header className="app-header">
      <section className="topbar">
        <div>
          <p className="eyebrow">Webull connection lab</p>
          <h1>Dhanam Krutva</h1>
        </div>
        <div className="top-actions">
          <button
            type="button"
            className="icon-button"
            onClick={onStart}
            disabled={liveRefreshActive}
            aria-label={liveRefreshActive ? "Webull running" : "Start Webull"}
            title={liveRefreshActive ? "Webull running" : "Start Webull"}
          >
            <span aria-hidden="true">{liveRefreshActive ? "ON" : "▶"}</span>
          </button>
          <button
            type="button"
            className="icon-button secondary-button"
            onClick={onStop}
            disabled={!liveRefreshActive}
            aria-label="Stop Webull"
            title="Stop Webull"
          >
            <span aria-hidden="true">■</span>
          </button>
          <div className="notification-anchor">
            <button
              type="button"
              className="icon-button notification-button"
              onClick={() => setNotificationsOpen((open) => !open)}
              aria-label="Open notifications"
              title="Notifications"
            >
              <span aria-hidden="true">🔔</span>
              {unreadCount ? <b>{unreadCount}</b> : null}
            </button>
            {notificationsOpen ? (
              <NotificationDrawer
                notificationLabel={notificationLabel}
                notifications={notifications}
                onEnableNotifications={onEnableNotifications}
                onMarkNotificationsRead={onMarkNotificationsRead}
                pushEnabled={pushEnabled}
              />
            ) : null}
          </div>
          <button type="button" className="icon-button" onClick={onRefresh} aria-label="Refresh" title="Refresh">
            <span aria-hidden="true">↻</span>
          </button>
        </div>
      </section>

      <section className="header-meta">
        <div className="meta-item">
          <span>Config</span>
          <strong>{status?.configured ? "Ready" : "Missing .env"}</strong>
        </div>
        <div className="meta-item">
          <span>Env</span>
          <strong>{environmentText}</strong>
          <em className={`mode-badge ${status?.data_mode === "live" ? "live" : "test"}`}>
            {status?.data_mode === "live" ? "LIVE DATA" : "TEST DATA"}
          </em>
        </div>
        <div className="meta-item endpoint-item">
          <span>Endpoint</span>
          <strong>{status?.endpoint || "-"}</strong>
        </div>
        <div className="meta-accounts">
          <span>Accounts {accounts.length}</span>
          {accounts.length ? accounts.map((account, index) => {
            const accountId = findAccountId(account);
            return (
              <button
                key={accountId || index}
                className={`account-chip ${accountId === selectedAccountId ? "active" : ""}`}
                type="button"
                onClick={() => onSelectAccount(accountId)}
              >
                <b>{accountId || "Unknown account"}</b>
                <small>{account.account_type || account.accountType || account.broker || "Webull"}</small>
              </button>
            );
          }) : <strong>-</strong>}
        </div>
      </section>
    </header>
  );
}

function NotificationDrawer({
  notificationLabel,
  notifications,
  onEnableNotifications,
  onMarkNotificationsRead,
  pushEnabled,
}) {
  return (
    <section className="notification-drawer" aria-label="Notifications">
      <div className="notification-drawer-header">
        <h2>Notifications</h2>
        <button type="button" onClick={onMarkNotificationsRead}>Mark all read</button>
      </div>
      <div className="push-row">
        <span aria-hidden="true">🔔</span>
        <p>Push notifications <strong>{pushEnabled ? "ON" : "OFF"}</strong> for this device.</p>
        <button type="button" onClick={onEnableNotifications} disabled={pushEnabled}>
          {pushEnabled ? "On" : notificationLabel}
        </button>
      </div>
      <div className="notification-list">
        {notifications.length ? notifications.map((item) => (
          <article key={item.id} className={`notification-item ${item.read ? "read" : "unread"}`}>
            <div className="notification-icon" aria-hidden="true">!</div>
            <div>
              <h3>{item.title}</h3>
              <p>{item.message}</p>
              <time dateTime={item.createdAt}>{relativeTime(item.createdAt)}</time>
            </div>
          </article>
        )) : (
          <article className="notification-empty">
            <strong>No notifications yet</strong>
            <span>MTF updates and push status changes will show here.</span>
          </article>
        )}
      </div>
    </section>
  );
}

function relativeTime(value) {
  const elapsedMs = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.round(elapsedMs / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function notificationButtonLabel(state) {
  if (!state?.supported) return "No Notifications";
  if (state.permission === "granted" && state.webPushConfigured && state.subscribed) return "Push Enabled";
  if (state.permission === "granted") return "Notify Enabled";
  if (state.permission === "denied") return "Notifications Blocked";
  return "Enable Notifications";
}
