const state = {
  accounts: [],
  selectedAccountId: null,
  scanInFlight: false,
  scanIntervalSeconds: 120,
};

const $ = (id) => document.getElementById(id);

function renderJson(target, value) {
  target.textContent = JSON.stringify(value, null, 2);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setAlert(message) {
  const alert = $("alert");
  alert.textContent = message || "";
  alert.classList.toggle("hidden", !message);
}

function renderStrategyResults(result) {
  $("strategy-symbols").textContent = String(result.symbols?.length || 0);
  $("strategy-signals").textContent = String(result.signals?.length || 0);
  $("strategy-status").textContent = result.status || "-";

  const alert = $("strategy-alert");
  const permissionError = result.data_errors?.[0]?.error;
  if (permissionError) {
    alert.textContent = permissionError.error || "Market data error. Check Webull market data subscription.";
    alert.classList.remove("hidden");
  } else {
    alert.classList.add("hidden");
  }

  const rows = $("strategy-results");
  rows.innerHTML = "";
  const displayRows = result.signals || [];
  if (!displayRows.length) {
    rows.innerHTML = '<p class="muted">No symbols are ready to trade right now.</p>';
    return;
  }

  for (const item of displayRows.slice(0, 20)) {
    const row = document.createElement("div");
    row.className = `order-row signal-row ${item.signal ? "signal-yes" : ""}`;
    row.innerHTML = `
      <b>${escapeHtml(item.symbol)}</b>
      <span>${item.side || "BUY"} ${item.quantity ?? 1} share</span>
      <span>Last ${item.last_price ?? "-"}${item.last_price_source ? ` (${item.last_price_source})` : ""}</span>
      <span>Stop ${item.stop_loss ?? "-"}</span>
      <span>Target ${item.day_high_target ?? "-"}</span>
      <button class="buy-one" type="button" data-symbol="${escapeHtml(item.symbol)}">Buy 1</button>
    `;
    rows.appendChild(row);
  }
}

function findAccountId(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAccountId(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const key of ["account_id", "accountId", "id"]) {
      if (value[key]) return String(value[key]);
    }
    for (const item of Object.values(value)) {
      const found = findAccountId(item);
      if (found) return found;
    }
  }
  return null;
}

function flattenAccounts(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.accounts)) return data.accounts;
  if (Array.isArray(data.account_list)) return data.account_list;
  if (Array.isArray(data.data)) return data.data;
  return [data];
}

async function getJson(path) {
  const response = await fetch(path);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.detail || `Request failed: ${response.status}`);
  }
  return body;
}

async function postJson(path, payload) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.detail || `Request failed: ${response.status}`);
  }
  return body;
}

async function loadStatus() {
  const status = await getJson("/api/status");
  $("configured").textContent = status.configured ? "Ready" : "Missing .env";
  $("environment").textContent = `${status.environment.toUpperCase()} / ${status.region.toUpperCase()}`;
  $("endpoint").textContent = status.endpoint;
  const mode = $("data-mode");
  mode.textContent = status.data_mode === "live" ? "LIVE DATA" : "TEST DATA";
  mode.className = `mode-badge ${status.data_mode === "live" ? "live" : "test"}`;
  if (!status.configured) {
    setAlert("Add WEBULL_APP_KEY and WEBULL_APP_SECRET to .env, then restart the server.");
  }
}

function renderAccounts() {
  const list = $("accounts");
  list.innerHTML = "";
  $("account-count").textContent = String(state.accounts.length);

  if (!state.accounts.length) {
    list.innerHTML = '<p class="muted">No accounts loaded yet.</p>';
    return;
  }

  for (const account of state.accounts) {
    const accountId = findAccountId(account);
    const button = document.createElement("button");
    button.className = `account ${accountId === state.selectedAccountId ? "active" : ""}`;
    button.type = "button";
    button.innerHTML = `
      <b>${accountId || "Unknown account"}</b>
      <small>${account.account_type || account.accountType || account.broker || "Webull account"}</small>
    `;
    button.addEventListener("click", () => {
      state.selectedAccountId = accountId;
      renderAccounts();
      loadAccountData();
    });
    list.appendChild(button);
  }
}

async function loadAccounts() {
  $("accounts").innerHTML = '<p class="muted">Loading accounts...</p>';
  const accounts = await getJson("/api/accounts");

  if (!accounts.ok) {
    setAlert(accounts.error || `Webull returned ${accounts.status_code}`);
  }
  state.accounts = flattenAccounts(accounts.data);
  state.selectedAccountId = state.selectedAccountId || findAccountId(state.accounts);
  $("selected-account").textContent = state.selectedAccountId || "No account selected";
  renderAccounts();
}

async function loadAccountData() {
  const accountId = state.selectedAccountId;
  $("selected-account").textContent = accountId || "No account selected";
}

async function refresh() {
  $("refresh").disabled = true;
  $("refresh").textContent = "Refreshing";
  try {
    await loadStatus();
    await loadAccounts();
  } catch (error) {
    setAlert(error.message);
  } finally {
    $("refresh").disabled = false;
    $("refresh").textContent = "Refresh";
  }
}

async function runStrategyScan(trigger = "manual") {
  if (state.scanInFlight) return;

  state.scanInFlight = true;
  $("scan-strategy").disabled = true;
  $("scan-strategy").textContent = "Scanning";
  $("strategy-status").textContent = trigger === "auto" ? "Auto scanning" : "Scanning";
  $("strategy-auto").textContent = "Running now, keeping last completed scan visible";

  try {
    const result = await getJson("/api/strategy/dry-run");
    renderStrategyResults(result);
    const now = new Date().toLocaleTimeString();
    $("strategy-auto").textContent = `Last ${now} · every 2 min`;
  } catch (error) {
    $("strategy-alert").textContent = error.message;
    $("strategy-alert").classList.remove("hidden");
    $("strategy-status").textContent = "Error";
    $("strategy-auto").textContent = "Retrying every 2 min";
  } finally {
    state.scanInFlight = false;
    $("scan-strategy").disabled = false;
    $("scan-strategy").textContent = "Scan Watchlist";
  }
}

$("refresh").addEventListener("click", refresh);
$("scan-strategy").addEventListener("click", () => runStrategyScan("manual"));
$("strategy-results").addEventListener("click", async (event) => {
  const button = event.target.closest(".buy-one");
  if (!button) return;

  const symbol = button.dataset.symbol;
  const accountId = state.selectedAccountId;
  if (!accountId) {
    $("strategy-alert").textContent = "Select an account before buying.";
    $("strategy-alert").classList.remove("hidden");
    return;
  }

  const confirmed = window.confirm(
    `Place a LIVE market BUY order for 1 share of ${symbol}?`
  );
  if (!confirmed) return;

  button.disabled = true;
  button.textContent = "Buying";
  try {
    const result = await postJson("/api/trade/buy", { account_id: accountId, symbol });
    $("strategy-alert").textContent = result.ok
      ? `Submitted BUY 1 ${symbol}.`
      : `BUY 1 ${symbol} failed at ${result.stage}.`;
    $("strategy-alert").classList.remove("hidden");
  } catch (error) {
    $("strategy-alert").textContent = error.message;
    $("strategy-alert").classList.remove("hidden");
  } finally {
    button.disabled = false;
    button.textContent = "Buy 1";
  }
});
refresh();
runStrategyScan("auto");
setInterval(() => runStrategyScan("auto"), state.scanIntervalSeconds * 1000);
