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
}) {
  const notificationLabel = notificationButtonLabel(notificationState);
  return (
    <header className="app-header">
      <section className="topbar">
        <div>
          <p className="eyebrow">Webull connection lab</p>
          <h1>Dhanam Krutva</h1>
        </div>
        <div className="top-actions">
          <button type="button" onClick={onStart} disabled={liveRefreshActive}>
            {liveRefreshActive ? "Webull Running" : "Start Webull"}
          </button>
          <button type="button" className="secondary-button" onClick={onStop} disabled={!liveRefreshActive}>
            Stop Webull
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={onEnableNotifications}
            disabled={!notificationState.supported || notificationState.permission === "granted"}
          >
            {notificationLabel}
          </button>
          <button type="button" onClick={onRefresh}>Refresh</button>
        </div>
      </section>

      <section className="header-grid">
        <StatusCard label="Configuration" value={status?.configured ? "Ready" : "Missing .env"} />
        <article className="panel">
          <span>Environment</span>
          <strong>{status ? `${status.environment.toUpperCase()} / ${status.region.toUpperCase()}` : "-"}</strong>
          <em className={`mode-badge ${status?.data_mode === "live" ? "live" : "test"}`}>
            {status?.data_mode === "live" ? "LIVE DATA" : "TEST DATA"}
          </em>
        </article>
        <StatusCard label="Endpoint" value={status?.endpoint || "-"} />
        <article className="panel header-accounts">
          <div className="section-heading">
            <h2>Accounts</h2>
            <span>{accounts.length}</span>
          </div>
          <div className="account-list">
            {accounts.length ? accounts.map((account, index) => {
              const accountId = findAccountId(account);
              return (
                <button
                  key={accountId || index}
                  className={`account ${accountId === selectedAccountId ? "active" : ""}`}
                  type="button"
                  onClick={() => onSelectAccount(accountId)}
                >
                  <b>{accountId || "Unknown account"}</b>
                  <small>{account.account_type || account.accountType || account.broker || "Webull account"}</small>
                </button>
              );
            }) : <p className="muted">No accounts loaded yet.</p>}
          </div>
        </article>
      </section>
    </header>
  );
}

function StatusCard({ label, value }) {
  return (
    <article className="panel">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function notificationButtonLabel(state) {
  if (!state?.supported) return "No Notifications";
  if (state.permission === "granted" && state.webPushConfigured && state.subscribed) return "Push Enabled";
  if (state.permission === "granted") return "Notify Enabled";
  if (state.permission === "denied") return "Notifications Blocked";
  return "Enable Notifications";
}
