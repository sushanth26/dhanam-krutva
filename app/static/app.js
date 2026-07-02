const state = {
  accounts: [],
  selectedAccountId: null,
  scanInFlight: false,
  scanIntervalSeconds: 120,
  liveRefreshTimer: null,
  liveRefreshActive: false,
  lastMtfSignature: null,
  mtfToastTimer: null,
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

function formatMoney(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "-";
  const sign = parsed < 0 ? "-" : "";
  return `${sign}$${Math.abs(parsed).toFixed(2)}`;
}

function pickFirst(item, keys) {
  for (const key of keys) {
    if (item?.[key] !== undefined && item[key] !== null && item[key] !== "") {
      return item[key];
    }
  }
  return null;
}

function tradePnl(item) {
  return Number(pickFirst(item, ["pnl", "pl", "profit_loss", "profitLoss", "realized_pl", "realizedPnl"]));
}

function tradeType(item) {
  const raw = String(pickFirst(item, ["trade_type", "tradeType", "type", "holding_period"]) || "day").toLowerCase();
  return raw.includes("swing") ? "swing" : "day";
}

function tradeCard(item) {
  const pnl = tradePnl(item);
  const pnlClass = pnl >= 0 ? "gain" : "loss";
  const type = tradeType(item) === "swing" ? "Swing" : "Day";
  const symbol = pickFirst(item, ["symbol", "ticker", "code"]) || "-";
  const quantity = pickFirst(item, ["quantity", "qty", "shares"]);

  return `
    <article class="trade-card ${pnlClass}">
      <div>
        <strong>${escapeHtml(symbol)}</strong>
        <span>${escapeHtml(type)}${quantity ? ` · ${escapeHtml(quantity)} sh` : ""}</span>
      </div>
      <b>${formatMoney(pnl)}</b>
    </article>
  `;
}

function tradeBucket(title, rows, kind) {
  const total = rows.reduce((sum, item) => sum + (tradePnl(item) || 0), 0);
  const empty = kind === "win" ? "No wins yet." : "No losses.";
  return `
    <section class="trade-bucket ${kind}">
      <header>
        <span>${title}</span>
        <strong>${rows.length} · ${formatMoney(total)}</strong>
      </header>
      <div class="trade-list">
        ${rows.length ? rows.map(tradeCard).join("") : `<p class="muted">${empty}</p>`}
      </div>
    </section>
  `;
}

function renderOutcomeBoard(target, rows) {
  const groups = [
    { key: "day", title: "Day Trades" },
    { key: "swing", title: "Swing Trades" },
  ];

  target.innerHTML = `
    <section class="trade-review-board" aria-label="Trade outcomes">
      ${groups.map((group) => {
        const trades = rows.filter((item) => tradeType(item) === group.key);
        const wins = trades.filter((item) => tradePnl(item) >= 0);
        const losses = trades.filter((item) => tradePnl(item) < 0);
        const total = trades.reduce((sum, item) => sum + (tradePnl(item) || 0), 0);

        return `
          <article class="trade-review-group">
            <header class="trade-review-header">
              <div>
                <span>${group.title}</span>
                <strong>${trades.length} trades</strong>
              </div>
              <b class="${total >= 0 ? "gain" : "loss"}">${formatMoney(total)}</b>
            </header>
            <div class="trade-outcome-grid">
              ${tradeBucket("Wins", wins, "win")}
              ${tradeBucket("Losses", losses, "loss")}
            </div>
          </article>
        `;
      }).join("")}
    </section>
  `;
}

function renderSignalBoard(target, displayRows) {
  target.innerHTML = "";
  if (!displayRows.length) {
    target.innerHTML = '<p class="muted">No symbols are ready to trade right now.</p>';
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
    target.appendChild(row);
  }
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
  const closedTrades = result.trades || result.closed_trades || result.closedTrades || [];
  const hasOutcomeData = closedTrades.some((item) => Number.isFinite(tradePnl(item)));
  if (hasOutcomeData) {
    renderOutcomeBoard(rows, closedTrades);
    return;
  }

  renderSignalBoard(rows, result.signals || []);
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

function formatPrice(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "-";
  return parsed.toFixed(2);
}

function formatPercent(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "-";
  return `${(parsed * 100).toFixed(2)}%`;
}

function emaTooltip(quote) {
  const e10 = quote.ema_10m || {};
  const e1h = quote.ema_1h || {};
  const daily = quote.ema_daily || {};
  return [
    `10m EMA 5: ${formatPrice(e10["5"])}`,
    `10m EMA 12: ${formatPrice(e10["12"])}`,
    `10m EMA 34: ${formatPrice(e10["34"])}`,
    `10m EMA 50: ${formatPrice(e10["50"])}`,
    `1h EMA 20: ${formatPrice(e1h["20"])}`,
    `1h EMA 21: ${formatPrice(e1h["21"])}`,
    `1h EMA 34: ${formatPrice(e1h["34"])}`,
    `1h EMA 50: ${formatPrice(e1h["50"])}`,
    `1h EMA 55: ${formatPrice(e1h["55"])}`,
    `Daily EMA 20: ${formatPrice(daily["20"])}`,
    `Daily EMA 21: ${formatPrice(daily["21"])}`,
    `Daily EMA 50: ${formatPrice(daily["50"])}`,
    `Daily EMA 55: ${formatPrice(daily["55"])}`,
  ].join("\n");
}

function cloudStatus(emaSet, fastKeys, slowKeys) {
  const fastValues = fastKeys.map((key) => Number(emaSet?.[key]));
  const slowValues = slowKeys.map((key) => Number(emaSet?.[key]));
  if ([...fastValues, ...slowValues].some((value) => !Number.isFinite(value))) return "-";

  const fastBottom = Math.min(...fastValues);
  const fastTop = Math.max(...fastValues);
  const slowBottom = Math.min(...slowValues);
  const slowTop = Math.max(...slowValues);

  if (fastBottom > slowTop) return "Above";
  if (fastTop < slowBottom) return "Below";
  return "Together";
}

function cloudTag(status) {
  const normalized = ["Above", "Below", "Together"].includes(status) ? String(status).toLowerCase() : "unknown";
  const label = status || "-";
  return `<span class="cloud-tag ${normalized}">${escapeHtml(label)}</span>`;
}

function renderLivePrices(payload) {
  const quotes = payload.quotes || [];

  if (!quotes.length) {
    $("green-prices").innerHTML = '<tr><td colspan="4">No green stocks returned.</td></tr>';
    $("red-prices").innerHTML = '<tr><td colspan="4">No red stocks returned.</td></tr>';
    $("mtf-prices").innerHTML = '<tr><td colspan="4">No MTF matches returned.</td></tr>';
    $("green-count").textContent = "0";
    $("red-count").textContent = "0";
    $("mtf-count").textContent = "0";
    return;
  }

  const green = quotes.filter((quote) => Number(quote.change) > 0);
  const red = quotes.filter((quote) => Number(quote.change) < 0);
  const mtfs = quotes.filter((quote) => quote.mtf_matches?.length);
  $("green-count").textContent = String(green.length);
  $("red-count").textContent = String(red.length);
  $("mtf-count").textContent = String(mtfs.length);

  $("mtf-prices").innerHTML = renderMtfRows(mtfs);
  $("green-prices").innerHTML = renderPriceRows(green, "green");
  $("red-prices").innerHTML = renderPriceRows(red, "red");
  $("live-prices").innerHTML = "";

  const updatedAt = new Date().toLocaleTimeString();
  $("live-prices-updated").textContent = `Updated ${updatedAt} from ${payload.source || "webull"}`;
  notifyMtfUpdate(mtfs, updatedAt);
}

function renderMtfRows(quotes) {
  if (!quotes.length) {
    return '<tr><td colspan="4">No stocks are on hourly or daily EMA clouds right now.</td></tr>';
  }

  return quotes.map((quote) => {
    const change = Number(quote.change);
    const rowClass = Number.isFinite(change) ? (change < 0 ? "day-red" : change > 0 ? "day-green" : "") : "";
    const tooltip = escapeHtml(emaTooltip(quote));
    const tags = quote.mtf_matches.map((match) => {
      const tagClass = mtfTagClass(match.label);
      return `<span class="mtf-tag ${tagClass}">${escapeHtml(match.label)}</span>`;
    }).join("");
    return `
      <tr class="stock-row ${rowClass}" title="${tooltip}" data-ema-tooltip="${tooltip}">
        <td><strong>${escapeHtml(quote.symbol)}</strong></td>
        <td class="mtf-tags">${tags}</td>
        <td class="price-cell">${formatPrice(quote.price)}</td>
        <td class="change-cell">${formatPrice(quote.change)} <span class="quote-size">${formatPercent(quote.change_ratio)}</span></td>
      </tr>
    `;
  }).join("");
}

function mtfSignature(quotes) {
  return quotes
    .map((quote) => `${quote.symbol}:${(quote.mtf_matches || []).map((match) => match.label).join("|")}`)
    .sort()
    .join(",");
}

function notifyMtfUpdate(quotes, updatedAt) {
  const signature = mtfSignature(quotes);
  const changed = state.lastMtfSignature !== null && signature !== state.lastMtfSignature;
  state.lastMtfSignature = signature;

  const matches = describeMtfMatches(quotes);
  const message = changed
    ? `MTFs changed: ${matches || "no matches"}`
    : `MTFs updated ${updatedAt}: ${matches || "no matches"}`;
  showMtfToast(message, changed);
}

function describeMtfMatches(quotes) {
  return quotes
    .map((quote) => {
      const labels = (quote.mtf_matches || []).map((match) => match.label).join(" + ");
      return labels ? `${quote.symbol} ${labels}` : quote.symbol;
    })
    .join(" • ");
}

function showMtfToast(message, changed = false) {
  const toast = $("mtf-toast");
  toast.textContent = message;
  toast.classList.toggle("changed", changed);
  toast.classList.remove("hidden");

  if (state.mtfToastTimer) {
    clearTimeout(state.mtfToastTimer);
  }
  state.mtfToastTimer = setTimeout(() => {
    toast.classList.add("hidden");
  }, changed ? 14000 : 10000);
}

function showDummyMtfToast() {
  showMtfToast(
    "MTFs changed: ASTS Hourly 34/50 • AMD Daily 20/21 • BE Daily 50/55 • LLY Hourly 34/50 + Daily 20/21",
    true
  );
}

function mtfTagClass(label) {
  const normalized = String(label || "").toLowerCase();
  if (normalized.includes("hourly")) return "hourly";
  if (normalized.includes("daily 20/21")) return "daily-fast";
  if (normalized.includes("daily 50/55")) return "daily-slow";
  return "default";
}

function renderPriceRows(quotes, kind) {
  if (!quotes.length) {
    return `<tr><td colspan="4">No ${kind} stocks right now.</td></tr>`;
  }

  const grouped = groupBySector(quotes);
  return Object.entries(grouped).map(([sector, sectorQuotes]) => `
    <tr class="sector-row sector-${sectorSlug(sector)}">
      <td colspan="4">${escapeHtml(sector)}</td>
    </tr>
    ${sectorQuotes.map(renderPriceRow).join("")}
  `).join("");
}

function groupBySector(quotes) {
  const sorted = [...quotes].sort((a, b) => {
    const sectorCompare = String(a.sector || "Other").localeCompare(String(b.sector || "Other"));
    if (sectorCompare !== 0) return sectorCompare;
    return String(a.symbol).localeCompare(String(b.symbol));
  });
  return sorted.reduce((groups, quote) => {
    const sector = quote.sector || "Other";
    groups[sector] = groups[sector] || [];
    groups[sector].push(quote);
    return groups;
  }, {});
}

function sectorSlug(sector) {
  return String(sector || "Other").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function renderPriceRow(quote) {
    const change = Number(quote.change);
    const rowClass = Number.isFinite(change) ? (change < 0 ? "day-red" : change > 0 ? "day-green" : "") : "";
    const tooltip = escapeHtml(emaTooltip(quote));
    const tenMinuteStatus = cloudStatus(quote.ema_10m, ["5", "12"], ["34", "50"]);
    return `
    <tr class="stock-row ${rowClass}" title="${tooltip}" data-ema-tooltip="${tooltip}">
      <td><strong>${escapeHtml(quote.symbol)}</strong></td>
      <td>${cloudTag(tenMinuteStatus)}</td>
      <td class="price-cell">${formatPrice(quote.price)}</td>
      <td class="change-cell">${formatPrice(quote.change)} <span class="quote-size">${formatPercent(quote.change_ratio)}</span></td>
    </tr>
  `;
}

const MARKET_REFRESH_INTERVAL_MS = 15000;
const PREMARKET_OPEN_LOCAL_MINUTES = 3 * 60;
const REGULAR_CLOSE_LOCAL_MINUTES = 15 * 60;

function isMarketRefreshWindow(date = new Date()) {
  const day = date.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = date.getHours() * 60 + date.getMinutes();
  return minutes >= PREMARKET_OPEN_LOCAL_MINUTES && minutes < REGULAR_CLOSE_LOCAL_MINUTES;
}

function setRefreshPausedMessage() {
  $("live-prices-updated").textContent = "Auto-refresh paused until premarket open";
}

function renderLiveRefreshControls() {
  $("start-live-prices").disabled = state.liveRefreshActive;
  $("stop-live-prices").disabled = !state.liveRefreshActive;
  $("start-live-prices").textContent = state.liveRefreshActive ? "Webull Running" : "Start Webull";
}

async function loadLivePrices({ manual = false } = {}) {
  if (!manual && !isMarketRefreshWindow()) {
    setRefreshPausedMessage();
    return;
  }

  const button = $("refresh-live-prices");
  const alert = $("live-prices-alert");

  button.disabled = true;
  button.textContent = "Refreshing";
  alert.classList.add("hidden");

  try {
    const result = await getJson("/api/webull/live-prices");
    renderLivePrices(result);
    if (result.errors?.length) {
      alert.textContent = `Some symbols failed: ${result.errors.map((item) => item.symbol).join(", ")}`;
      alert.classList.remove("hidden");
    }
  } catch (error) {
    alert.textContent = error.message;
    alert.classList.remove("hidden");
  } finally {
    button.disabled = false;
    button.textContent = "Refresh Prices";
  }
}

function startLivePriceRefresh() {
  if (state.liveRefreshTimer) {
    clearInterval(state.liveRefreshTimer);
  }
  state.liveRefreshActive = true;
  renderLiveRefreshControls();
  loadLivePrices({ manual: true });
  state.liveRefreshTimer = setInterval(loadLivePrices, MARKET_REFRESH_INTERVAL_MS);
}

function stopLivePriceRefresh() {
  if (state.liveRefreshTimer) {
    clearInterval(state.liveRefreshTimer);
  }
  state.liveRefreshTimer = null;
  state.liveRefreshActive = false;
  renderLiveRefreshControls();
  $("live-prices-updated").textContent = "Webull polling stopped";
}

function renderTradingViewAnalysis(payload) {
  const analysis = payload.analysis || {};
  const technical = analysis.technical || {};
  const priceData = technical.price_data || {};
  const sentiment = technical.market_sentiment || {};
  const trend = technical.market_structure || {};
  const recommendation = analysis.confluence?.recommendation || "-";
  const bias = technical.timeframe_context?.bias || trend.trend || "-";
  const currentPrice = priceData.current_price ?? priceData.close;

  $("tv-server").textContent = payload.server?.name || "TradingView MCP";
  $("tv-signal").textContent = sentiment.buy_sell_signal || recommendation;
  $("tv-price").textContent = currentPrice === undefined ? "-" : String(currentPrice);
  $("tv-trend").textContent = bias;

  const rows = [
    ["RSI", technical.rsi?.value, technical.rsi?.signal],
    ["MACD", technical.macd?.crossover, technical.macd?.histogram],
    ["Grade", technical.grade, technical.trend_state],
    ["Reddit", analysis.sentiment?.sentiment_label, `${analysis.sentiment?.posts_analyzed ?? 0} posts`],
    ["News", `${analysis.news?.count ?? 0} items`, ""],
  ];

  $("tradingview-results").innerHTML = `
    <div class="tv-summary">
      ${rows.map(([label, value, detail]) => `
        <article>
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value ?? "-")}</strong>
          <small>${escapeHtml(detail ?? "")}</small>
        </article>
      `).join("")}
    </div>
    <pre>${escapeHtml(JSON.stringify(analysis, null, 2))}</pre>
  `;
}

async function runTradingViewAnalysis() {
  const symbol = $("tv-symbol").value.trim().toUpperCase() || "AAPL";
  const exchange = $("tv-exchange").value;
  const timeframe = $("tv-timeframe").value;
  const button = $("run-tradingview");
  const alert = $("tradingview-alert");

  button.disabled = true;
  button.textContent = "Analyzing";
  alert.classList.add("hidden");
  $("tv-server").textContent = "Starting MCP";
  $("tv-signal").textContent = "-";
  $("tv-price").textContent = "-";
  $("tv-trend").textContent = "-";

  try {
    const query = new URLSearchParams({ symbol, exchange, timeframe });
    const result = await getJson(`/api/tradingview/analyze?${query}`);
    renderTradingViewAnalysis(result);
  } catch (error) {
    alert.textContent = error.message;
    alert.classList.remove("hidden");
    $("tv-server").textContent = "Error";
  } finally {
    button.disabled = false;
    button.textContent = "Analyze";
  }
}

$("refresh").addEventListener("click", refresh);
$("scan-strategy").addEventListener("click", () => runStrategyScan("manual"));
$("refresh-live-prices").addEventListener("click", () => loadLivePrices({ manual: true }));
$("test-mtf-toast").addEventListener("click", showDummyMtfToast);
$("start-live-prices").addEventListener("click", startLivePriceRefresh);
$("stop-live-prices").addEventListener("click", stopLivePriceRefresh);
$("run-tradingview").addEventListener("click", runTradingViewAnalysis);
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
renderLiveRefreshControls();
$("live-prices-updated").textContent = "Webull polling stopped";
runStrategyScan("auto");
setInterval(() => runStrategyScan("auto"), state.scanIntervalSeconds * 1000);
