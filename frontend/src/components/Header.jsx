import { useEffect, useRef, useState } from "react";

import { AlertStrategies } from "./AlertStrategies";
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
  onDisableNotifications,
  notifications,
  onMarkNotificationsRead,
  strategyState,
  onToggleStrategy,
}) {
  const accountAnchorRef = useRef(null);
  const notificationAnchorRef = useRef(null);
  const strategiesAnchorRef = useRef(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [strategiesOpen, setStrategiesOpen] = useState(false);
  const notificationLabel = notificationButtonLabel(notificationState);
  const environmentText = status ? `${status.environment.toUpperCase()} / ${status.region.toUpperCase()}` : "-";
  const unreadCount = notifications.filter((item) => !item.read).length;
  const pushEnabled = notificationState.permission === "granted" && notificationState.appEnabled !== false;
  const selectedAccount = accounts.find((account) => findAccountId(account) === selectedAccountId);
  const selectedAccountLabel = findAccountId(selectedAccount) || `${accounts.length} accounts`;

  useEffect(() => {
    function closeOverlaysOnOutsidePointer(event) {
      const target = event.target;
      if (accountAnchorRef.current && !accountAnchorRef.current.contains(target)) {
        setAccountMenuOpen(false);
      }
      if (notificationAnchorRef.current && !notificationAnchorRef.current.contains(target)) {
        setNotificationsOpen(false);
      }
      if (strategiesAnchorRef.current && !strategiesAnchorRef.current.contains(target)) {
        setStrategiesOpen(false);
      }
    }

    function closeOverlaysOnEscape(event) {
      if (event.key === "Escape") {
        setAccountMenuOpen(false);
        setNotificationsOpen(false);
        setStrategiesOpen(false);
      }
    }

    document.addEventListener("pointerdown", closeOverlaysOnOutsidePointer);
    document.addEventListener("keydown", closeOverlaysOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOverlaysOnOutsidePointer);
      document.removeEventListener("keydown", closeOverlaysOnEscape);
    };
  }, []);

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
          <div className="strategy-menu-anchor" ref={strategiesAnchorRef}>
            <button
              type="button"
              className="account-menu-button secondary-button"
              onClick={() => {
                setStrategiesOpen((open) => !open);
                setAccountMenuOpen(false);
                setNotificationsOpen(false);
              }}
              aria-label="Open strategy menu"
              title="Strategies"
            >
              <span>Strategies</span>
              <b>{Object.values(strategyState || {}).filter((enabled) => enabled !== false).length}</b>
            </button>
            {strategiesOpen ? (
              <div className="strategy-menu">
                <AlertStrategies strategyState={strategyState} onToggleStrategy={onToggleStrategy} />
              </div>
            ) : null}
          </div>
          <div className="account-menu-anchor" ref={accountAnchorRef}>
            <button
              type="button"
              className="account-menu-button secondary-button"
              onClick={() => {
                setAccountMenuOpen((open) => !open);
                setNotificationsOpen(false);
                setStrategiesOpen(false);
              }}
              aria-label="Open account menu"
              title="Accounts"
            >
              <span>Accounts</span>
              <b>{accounts.length}</b>
            </button>
            {accountMenuOpen ? (
              <AccountMenu
                accounts={accounts}
                environmentText={environmentText}
                onSelectAccount={(accountId) => {
                  onSelectAccount(accountId);
                  setAccountMenuOpen(false);
                }}
                selectedAccountId={selectedAccountId}
                selectedAccountLabel={selectedAccountLabel}
                status={status}
              />
            ) : null}
          </div>
          <div className="notification-anchor" ref={notificationAnchorRef}>
            <button
              type="button"
              className="icon-button notification-button"
              onClick={() => {
                setNotificationsOpen((open) => !open);
                setAccountMenuOpen(false);
                setStrategiesOpen(false);
              }}
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
                canEnableNotifications={notificationState.permission !== "denied"}
                onDisableNotifications={onDisableNotifications}
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
    </header>
  );
}

function AccountMenu({
  accounts,
  environmentText,
  onSelectAccount,
  selectedAccountId,
  selectedAccountLabel,
  status,
}) {
  return (
    <section className="account-menu" aria-label="Account menu">
      <div className="account-menu-header">
        <span>Selected</span>
        <strong>{selectedAccountLabel}</strong>
      </div>
      <div className="account-menu-status">
        <MetaLine label="Config" value={status?.configured ? "Ready" : "Missing .env"} />
        <MetaLine
          label="Env"
          value={environmentText}
          badge={status?.data_mode === "live" ? "LIVE DATA" : "TEST DATA"}
          badgeKind={status?.data_mode === "live" ? "live" : "test"}
        />
        <MetaLine label="Endpoint" value={status?.endpoint || "-"} />
      </div>
      <div className="account-menu-list">
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
  );
}

function MetaLine({ badge, badgeKind = "test", label, value }) {
  return (
    <div className="account-meta-line">
      <span>{label}</span>
      <strong>{value}</strong>
      {badge ? <em className={`mode-badge ${badgeKind}`}>{badge}</em> : null}
    </div>
  );
}

function NotificationDrawer({
  canEnableNotifications,
  notificationLabel,
  notifications,
  onDisableNotifications,
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
        <button
          type="button"
          onClick={pushEnabled ? onDisableNotifications : onEnableNotifications}
          disabled={!pushEnabled && !canEnableNotifications}
        >
          {pushEnabled ? "Turn off" : notificationLabel}
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
  if (state.permission === "denied") return "Blocked in browser";
  if (state.permission === "default") return "Allow notifications";
  if (state.appEnabled === false) return "Turn on";
  if (state.permission === "granted" && state.webPushConfigured && state.subscribed) return "Push Enabled";
  if (state.permission === "granted") return "Notify Enabled";
  return "Enable Notifications";
}
