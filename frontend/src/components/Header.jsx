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
  onTestNotification,
}) {
  const notificationLabel = notificationButtonLabel(notificationState);
  const environmentText = status ? `${status.environment.toUpperCase()} / ${status.region.toUpperCase()}` : "-";
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
          <button
            type="button"
            className="icon-button secondary-button"
            onClick={onEnableNotifications}
            disabled={!notificationState.supported || notificationState.permission === "granted"}
            aria-label={notificationLabel}
            title={notificationLabel}
          >
            <span aria-hidden="true">{notificationState.permission === "granted" ? "🔔" : "!"}</span>
          </button>
          <button
            type="button"
            className="icon-button secondary-button"
            onClick={onTestNotification}
            aria-label="Test notification alarm"
            title="Test notification alarm"
          >
            <span aria-hidden="true">⚠</span>
          </button>
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

function notificationButtonLabel(state) {
  if (!state?.supported) return "No Notifications";
  if (state.permission === "granted" && state.webPushConfigured && state.subscribed) return "Push Enabled";
  if (state.permission === "granted") return "Notify Enabled";
  if (state.permission === "denied") return "Notifications Blocked";
  return "Enable Notifications";
}
