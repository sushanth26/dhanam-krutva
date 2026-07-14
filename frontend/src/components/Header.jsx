import { useEffect, useRef, useState } from "react";

import { accountTypeText, findAccountId, isMarginAccount } from "../lib/market";

export function Header({
  status,
  accounts,
  selectedAccountId,
  loading,
  pageLoading,
  onRefresh,
  onSelectAccount,
  notificationState,
  onEnableNotifications,
  onDisableNotifications,
  notifications,
  onMarkNotificationsRead,
  onTestPushNotifications,
  activePage,
  onNavigate,
  settingsBadge,
  settingsControls,
}) {
  const accountAnchorRef = useRef(null);
  const notificationAnchorRef = useRef(null);
  const settingsAnchorRef = useRef(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
      if (settingsAnchorRef.current && !settingsAnchorRef.current.contains(target)) {
        setSettingsOpen(false);
      }
    }

    function closeOverlaysOnEscape(event) {
      if (event.key === "Escape") {
        setAccountMenuOpen(false);
        setNotificationsOpen(false);
        setSettingsOpen(false);
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
            className={`account-menu-button secondary-button ${activePage === "home" ? "active" : ""}`}
            disabled={pageLoading}
            onClick={() => onNavigate("home")}
            aria-label="Open scanner"
            title="Scanner"
          >
            <span>Scanner</span>
          </button>
          <button
            type="button"
            className={`account-menu-button secondary-button ${activePage === "mtfs" ? "active" : ""}`}
            disabled={pageLoading}
            onClick={() => onNavigate("mtfs")}
            aria-label="Open MTFs"
            title="MTFs"
          >
            <span>MTFs</span>
          </button>
          <div className="settings-menu-anchor" ref={settingsAnchorRef}>
            <button
              type="button"
              className="account-menu-button secondary-button"
              disabled={pageLoading}
              onClick={() => {
                setSettingsOpen((open) => !open);
                setAccountMenuOpen(false);
                setNotificationsOpen(false);
              }}
              aria-label="Open settings menu"
              title="Settings"
            >
              <span>Settings</span>
              <b>{settingsBadge}</b>
            </button>
            {settingsOpen ? (
              <div className="settings-menu">
                {settingsControls}
              </div>
            ) : null}
          </div>
          <div className="account-menu-anchor" ref={accountAnchorRef}>
            <button
              type="button"
              className="account-menu-button secondary-button"
              disabled={pageLoading}
              onClick={() => {
                setAccountMenuOpen((open) => !open);
                setNotificationsOpen(false);
                setSettingsOpen(false);
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
              disabled={pageLoading}
              onClick={() => {
                setNotificationsOpen((open) => !open);
                setAccountMenuOpen(false);
                setSettingsOpen(false);
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
                notificationState={notificationState}
                notifications={notifications}
                canEnableNotifications={notificationState.permission !== "denied"}
                onDisableNotifications={onDisableNotifications}
                onEnableNotifications={onEnableNotifications}
                onMarkNotificationsRead={onMarkNotificationsRead}
                onTestPushNotifications={onTestPushNotifications}
                pushEnabled={pushEnabled}
              />
            ) : null}
          </div>
          <button type="button" className="icon-button" onClick={onRefresh} disabled={pageLoading} aria-label="Refresh" title="Refresh">
            <span aria-hidden="true">{loading?.shell ? "…" : "↻"}</span>
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
          const accountType = accountTypeText(account) || "WEBULL";
          const canTrade = isMarginAccount(account);
          return (
            <button
              key={accountId || index}
              className={`account-chip ${accountId === selectedAccountId ? "active" : ""} ${canTrade ? "" : "view-only"}`}
              type="button"
              disabled={!canTrade}
              title={canTrade ? "Margin account for trading" : "Cash account is view-only for this app"}
              onClick={() => onSelectAccount(accountId)}
            >
              <b>{accountId || "Unknown account"}</b>
              <small>{canTrade ? accountType : `${accountType} · VIEW ONLY`}</small>
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
  notificationState,
  notifications,
  onDisableNotifications,
  onEnableNotifications,
  onMarkNotificationsRead,
  onTestPushNotifications,
  pushEnabled,
}) {
  const closedAppStatus = closedAppPushStatus(notificationState || {}, pushEnabled);
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
      <ClosedAppPushPanel
        canSendTest={pushEnabled && closedAppStatus.ready}
        onTestPushNotifications={onTestPushNotifications}
        status={closedAppStatus}
      />
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

function ClosedAppPushPanel({ canSendTest, onTestPushNotifications, status }) {
  return (
    <section className={`closed-push-panel ${status.ready ? "ready" : "blocked"}`} aria-label="Closed app push status">
      <div>
        <span>Closed-app push</span>
        <strong>{status.label}</strong>
      </div>
      <p>{status.detail}</p>
      <ul>
        {status.items.map((item) => (
          <li className={item.ok ? "ok" : "missing"} key={item.label}>
            <b aria-hidden="true"></b>
            <span>{item.label}</span>
          </li>
        ))}
      </ul>
      <button type="button" onClick={onTestPushNotifications} disabled={!canSendTest}>
        Send test push
      </button>
    </section>
  );
}

function closedAppPushStatus(state, pushEnabled) {
  const items = [
    { label: "VAPID keys", ok: state.webPushConfigured },
    { label: "Background monitor", ok: state.mtfPushEnabled && state.monitorRunning },
    { label: "This device subscribed", ok: state.subscribed || state.subscriptions > 0 },
    { label: "Market window", ok: state.marketWindow },
  ];
  const ready = pushEnabled && items.slice(0, 3).every((item) => item.ok);
  if (!state.webPushConfigured) {
    return {
      ready: false,
      label: "Needs VAPID keys",
      detail: "Browser alerts can work while the app is open, but closed-app phone push needs VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.",
      items,
    };
  }
  if (!state.mtfPushEnabled) {
    return {
      ready: false,
      label: "Monitor off",
      detail: "Set MTF_PUSH_ENABLED=true and restart the server so the backend can poll while the app is closed.",
      items,
    };
  }
  if (!state.monitorRunning) {
    return {
      ready: false,
      label: "Restart needed",
      detail: "The background monitor is not running. Restart FastAPI after changing push environment variables.",
      items,
    };
  }
  if (!pushEnabled || !state.subscribed) {
    return {
      ready: false,
      label: "Subscribe this device",
      detail: "Tap the notification enable button once on the device that should receive phone alerts.",
      items,
    };
  }
  return {
    ready: true,
    label: "Ready",
    detail: state.marketWindow
      ? `Backend polling is active about every ${state.pollSeconds || 300}s.`
      : "Configured and subscribed. Polling resumes during the market refresh window.",
    items,
  };
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
