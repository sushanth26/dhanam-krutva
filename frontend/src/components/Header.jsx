import { useEffect, useRef, useState } from "react";

import { accountTypeText, findAccountId, isMarginAccount } from "../lib/market";

export function Header({
  status,
  accounts,
  accountCount,
  accountsConfirmedAt,
  accountsLoading,
  accountsConfirmed,
  selectedAccountId,
  pageLoading,
  onSelectAccount,
  onRefreshAccounts,
  notificationState,
  onEnableNotifications,
  onDisableNotifications,
  onRetryNotificationCheck,
  notifications,
  onMarkNotificationsRead,
  activePage,
  onNavigate,
  alertLogCount,
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
  const totalAccountCount = accountCount ?? accounts.length;
  const selectedAccountLabel = findAccountId(selectedAccount) || `${totalAccountCount} accounts`;
  const connectionLabel = accountsLoading ? "Checking Webull" : accountsConfirmed ? "Webull ready" : "Webull not ready";
  const confirmedTime = accountsConfirmedAt ? new Date(accountsConfirmedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
  const connectionDetail = accountsConfirmed
    ? `${totalAccountCount} account${totalAccountCount === 1 ? "" : "s"} · checked ${confirmedTime || "now"} · 5 min prices/alerts`
    : "Confirm accounts before prices or alerts run";

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
        <div className="brand-block">
          <h1>Dhanam Krutva</h1>
          <p>Scanner, MTF alerts, and auto-trade controls</p>
        </div>
        <div className="top-actions">
          <nav className="primary-nav" aria-label="Main views">
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
              aria-label="Open MTF signals"
              title="MTF Signals"
            >
              <span>MTFs</span>
            </button>
            <button
              type="button"
              className={`account-menu-button secondary-button ${activePage === "trades" ? "active" : ""}`}
              disabled={pageLoading}
              onClick={() => onNavigate("trades")}
              aria-label="Open auto trades"
              title="Auto Trades"
            >
              <span>Trades</span>
            </button>
            <button
              type="button"
              className={`account-menu-button secondary-button ${activePage === "alerts" ? "active" : ""}`}
              disabled={pageLoading}
              onClick={() => onNavigate("alerts")}
              aria-label="Open alerts history"
              title="Alerts"
            >
              <span>Alerts</span>
              <b>{alertLogCount || 0}</b>
            </button>
          </nav>
          <div className={`connection-summary ${accountsConfirmed ? "ready" : "blocked"}`}>
            <div>
              <strong>{connectionLabel}</strong>
              <span>{connectionDetail}</span>
            </div>
            <button
              type="button"
              className="account-refresh-button secondary-button"
              disabled={accountsLoading}
              onClick={() => {
                onRefreshAccounts();
                setAccountMenuOpen(false);
                setNotificationsOpen(false);
                setSettingsOpen(false);
              }}
              aria-label="Confirm Webull account API"
              title="Confirm Webull account API"
            >
              {accountsLoading ? "Checking" : "Check API"}
            </button>
          </div>
          <div className="utility-actions">
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
                <b>{totalAccountCount}</b>
              </button>
              {accountMenuOpen ? (
                <AccountMenu
                accounts={accounts}
                accountCount={totalAccountCount}
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
                  onRetryNotificationCheck={onRetryNotificationCheck}
                  pushEnabled={pushEnabled}
                />
              ) : null}
            </div>
          </div>
        </div>
      </section>
    </header>
  );
}

function AccountMenu({
  accounts,
  accountCount,
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
        <span>Accounts {accountCount}</span>
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
  onRetryNotificationCheck,
  pushEnabled,
}) {
  const permissionText = notificationState.permission === "granted"
    ? "Allowed"
    : notificationState.permission === "denied" ? "Blocked" : "Not allowed yet";
  const closedAppText = notificationState.webPushConfigured
    ? (notificationState.subscribed ? "Ready" : "Not subscribed")
    : "Not configured";
  const actionLabel = pushEnabled ? "Disable this device" : notificationLabel;
  return (
    <section className="notification-drawer" aria-label="Notifications">
      <div className="notification-drawer-header">
        <h2>Notifications</h2>
        <button type="button" onClick={onMarkNotificationsRead}>Mark all read</button>
      </div>
      <div className="push-row">
        <span aria-hidden="true">🔔</span>
        <div className="notification-state-grid">
          <StatusLine label="Browser permission" value={permissionText} active={notificationState.permission === "granted"} />
          <StatusLine label="This device alerts" value={pushEnabled ? "On" : "Off"} active={pushEnabled} />
          <StatusLine label="Closed-app push" value={closedAppText} active={notificationState.webPushConfigured && notificationState.subscribed} />
        </div>
        <button
          type="button"
          onClick={pushEnabled ? onDisableNotifications : onEnableNotifications}
          disabled={!pushEnabled && !canEnableNotifications}
        >
          {actionLabel}
        </button>
        <button type="button" className="notification-retry-button" onClick={onRetryNotificationCheck}>
          Retry MTF check
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

function StatusLine({ active, label, value }) {
  return (
    <p className={`notification-status-line ${active ? "active" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </p>
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
  if (state.permission === "denied") return "Open browser settings";
  if (state.permission === "default") return "Enable on this device";
  if (state.appEnabled === false) return "Enable this device";
  if (state.permission === "granted") return "Enabled";
  return "Enable this device";
}
