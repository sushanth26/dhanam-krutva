import { useEffect, useMemo, useRef, useState } from "react";

import { AlertStrategies } from "./components/AlertStrategies";
import { Header } from "./components/Header";
import { HiddenLegacyPanels } from "./components/HiddenLegacyPanels";
import { MtfTable, PreMarketScannerTable, PriceBucket } from "./components/PriceTables";
import { deleteJson, getJson, postJson } from "./lib/api";
import { ALERT_STRATEGIES, filterQuotesByStrategy, loadStrategyState, saveStrategyState, strategyIdForMatch } from "./lib/alertStrategies";
import { cloudStatus, confirmedMtfQuotes, displayMtfLabel, flattenAccounts, formatPrice, isMarketRefreshWindow, marginTradingAccountId, matchEntryPrice, notificationMatchText, mtfSignature, preferredAccountId } from "./lib/market";
import { disableNotifications, enableNotifications, loadNotificationState, setAppBadgeCount, showDeviceNotification, syncNotificationPreferences } from "./lib/notifications";

const PASSIVE_MARKET_REFRESH_INTERVAL_MS = 30 * 1000;
const MAX_NOTIFICATIONS = 20;
const MAX_ALERT_LOG = 500;
const DAILY_SYMBOLS_KEY = "dhanam-daily-symbols";
const WATCHLISTS_KEY = "dhanam-watchlists";
const SCANNER_WATCHLISTS_KEY = "dhanam-scanner-watchlists";
const RISK_SETTINGS_KEY = "dhanam-risk-settings";
const ALERT_LOG_KEY = "dhanam-alert-log";
const RETAINED_MTF_QUOTES_KEY = "dhanam-retained-mtf-quotes";
const AUTO_TRADE_KEY = "dhanam-auto-trade";
const AUTO_TRADE_EXECUTIONS_KEY = "dhanam-auto-trade-executions";
const MAX_AUTO_TRADE_EXECUTIONS = 500;
const WATCHLIST_REFRESH_CONCURRENCY = 1;
const OG_WATCHLIST_ID = "og";
const SCANNER_ALERT_STRATEGY_ID = "pre-market-scanner";
const OG_SYMBOLS = [
  "BE", "CRDO", "AAOI", "SNDK", "MU", "GLW", "MRVL", "COHR", "RKLB",
  "ASTS", "AMD", "ARM", "AVGO", "DELL", "INTC", "APP", "LLY",
  "APLD", "CIFR", "CRWV", "HUT", "IREN", "NBIS", "WULF",
];

function loadDailySymbols() {
  try {
    const value = JSON.parse(window.localStorage.getItem(DAILY_SYMBOLS_KEY) || "[]");
    return Array.isArray(value) ? normalizeSymbols(value) : [];
  } catch {
    return [];
  }
}

function loadWatchlists() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(WATCHLISTS_KEY) || "[]");
    if (Array.isArray(saved) && saved.length) {
      return normalizeWatchlists(saved);
    }
  } catch {
    // Fall back to the seeded lists below.
  }
  const dailySymbols = loadDailySymbols();
  return normalizeWatchlists([
    { id: OG_WATCHLIST_ID, name: "OG list", symbols: OG_SYMBOLS, locked: true },
    ...(dailySymbols.length ? [{ id: "daily", name: "Daily list", symbols: dailySymbols }] : []),
  ]);
}

function saveWatchlists(watchlists) {
  window.localStorage.setItem(WATCHLISTS_KEY, JSON.stringify(watchlists));
}

function loadScannerWatchlistIds(watchlists) {
  try {
    const saved = JSON.parse(window.localStorage.getItem(SCANNER_WATCHLISTS_KEY) || "null");
    if (Array.isArray(saved)) {
      const ids = new Set(watchlists.map((watchlist) => watchlist.id));
      return saved.filter((id) => ids.has(id));
    }
  } catch {
    // Fall back to all watchlists.
  }
  return watchlists.map((watchlist) => watchlist.id);
}

function saveScannerWatchlistIds(ids) {
  window.localStorage.setItem(SCANNER_WATCHLISTS_KEY, JSON.stringify(ids));
}

function normalizeWatchlists(watchlists) {
  const normalized = [];
  const seenIds = new Set();
  for (const item of watchlists) {
    const name = String(item?.name || "").trim() || "Watchlist";
    const baseId = item?.id === OG_WATCHLIST_ID ? OG_WATCHLIST_ID : slugify(name);
    const id = uniqueId(baseId, seenIds);
    seenIds.add(id);
    normalized.push({
      id,
      name: id === OG_WATCHLIST_ID ? "OG list" : name,
      symbols: normalizeSymbols(item?.symbols || []).slice(0, 25),
      locked: id === OG_WATCHLIST_ID,
      autoTradeEnabled: item?.autoTradeEnabled !== false && item?.auto_trade_enabled !== false && item?.do_not_auto_trade !== true,
    });
  }
  if (!normalized.some((item) => item.id === OG_WATCHLIST_ID)) {
    normalized.unshift({ id: OG_WATCHLIST_ID, name: "OG list", symbols: OG_SYMBOLS, locked: true, autoTradeEnabled: true });
  }
  return normalized;
}

function normalizeSymbols(value) {
  const seen = new Set();
  return value
    .flatMap((item) => String(item || "").split(/[,\s]+/))
    .map((symbol) => symbol.trim().toUpperCase())
    .filter((symbol) => {
      if (!symbol || seen.has(symbol)) return false;
      seen.add(symbol);
      return true;
    });
}

function slugify(value) {
  return String(value || "watchlist").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "watchlist";
}

function uniqueId(baseId, usedIds) {
  let id = baseId || "watchlist";
  let index = 2;
  while (usedIds.has(id)) {
    id = `${baseId}-${index}`;
    index += 1;
  }
  return id;
}

function initialTabState(watchlists, value) {
  return watchlists.reduce((state, watchlist) => ({ ...state, [watchlist.id]: value }), {});
}

function emptyAutoTradeOrders() {
  return {
    ok: true,
    orders: [],
    buckets: { buy: [], sell: [], open: [], filled: [] },
    counts: { buy: 0, sell: 0, open: 0, filled: 0 },
  };
}

function shouldPromoteLocalWatchlists(serverWatchlists, localWatchlists) {
  const serverOnlyDefaultOg = serverWatchlists.length === 1
    && serverWatchlists[0]?.id === OG_WATCHLIST_ID
    && serverWatchlists[0]?.symbols?.join(",") === OG_SYMBOLS.join(",");
  const localHasCustomState = localWatchlists.length > 1
    || localWatchlists[0]?.symbols?.join(",") !== OG_SYMBOLS.join(",");
  return serverOnlyDefaultOg && localHasCustomState;
}

function mtfRowId(tab, symbol) {
  return `${tab}:${symbol}`;
}

function scannerRowKey(row) {
  return `${row.symbol}:${row.action}`;
}

function mtfRowSignature(quote) {
  const labels = (quote.mtf_matches || []).map((match) => `${match.label}:${matchEntryPrice(match) ?? ""}`).sort().join("|");
  return `${quote.symbol}:${labels}`;
}

function mtfMatchKey(match) {
  return [
    match?.trade_action || "watch",
    match?.label || "",
    match?.type || "",
    match?.direction || "",
    match?.candle_time || "",
  ].join(":");
}

function loadRetainedMtfQuotes() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(RETAINED_MTF_QUOTES_KEY) || "{}");
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  } catch {
    return {};
  }
}

function saveRetainedMtfQuotes(value) {
  window.localStorage.setItem(RETAINED_MTF_QUOTES_KEY, JSON.stringify(value));
}

function clearRetainedMtfQuotes() {
  window.localStorage.removeItem(RETAINED_MTF_QUOTES_KEY);
}

function mergeMtfMatches(currentMatches = [], retainedMatches = []) {
  const merged = [];
  const seen = new Set();
  for (const match of [
    ...currentMatches,
    ...retainedMatches.filter((item) => item.type !== "mtf_cloud_touch"),
  ]) {
    const key = mtfMatchKey(match);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(match);
  }
  return merged;
}

function splitMtfQuoteByAction(quote, action) {
  const matches = dedupeMtfMatches(
    (quote.mtf_matches || []).filter((match) => match.trade_action === action),
  );
  return matches.length ? { ...quote, mtf_matches: matches } : null;
}

function dedupeMtfMatches(matches = []) {
  const deduped = [];
  const seen = new Set();
  for (const match of matches) {
    const key = mtfMatchKey(match);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(match);
  }
  return deduped;
}

function mergeRetainedMtfQuotesForTab(retainedByTab, tab, nextQuotes) {
  const currentSymbols = new Set(nextQuotes.map((quote) => quote.symbol));
  const currentBySymbol = Object.fromEntries(nextQuotes.map((quote) => [quote.symbol, quote]));
  const previousTab = retainedByTab[tab] || {};
  const nextTab = {};
  const mergedQuotes = nextQuotes.map((quote) => {
    const retained = previousTab[quote.symbol];
    const matches = mergeMtfMatches(quote.mtf_matches || [], retained?.mtf_matches || []);
    if (!matches.length) return quote;
    const merged = {
      ...(retained || {}),
      ...quote,
      mtf_matches: matches,
      retained_at: retained?.retained_at || new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    };
    nextTab[quote.symbol] = merged;
    return merged;
  });

  for (const [symbol, retained] of Object.entries(previousTab)) {
    if (!currentSymbols.has(symbol)) continue;
    if (nextTab[symbol]) continue;
    const current = currentBySymbol[symbol];
    const retainedMatches = (retained.mtf_matches || []).filter((match) => match.type !== "mtf_cloud_touch");
    if (!retainedMatches.length) continue;
    const merged = {
      ...retained,
      ...(current || {}),
      mtf_matches: retainedMatches,
      last_seen_at: new Date().toISOString(),
    };
    nextTab[symbol] = merged;
    mergedQuotes.push(merged);
  }

  return {
    retainedByTab: { ...retainedByTab, [tab]: nextTab },
    quotes: mergedQuotes,
  };
}

function mtfNotificationDetails(quotes) {
  const matches = quotes
    .map((quote) => ({
      symbol: quote.symbol,
      labels: (quote.mtf_matches || []).map((match) => notificationMatchText(match)).filter(Boolean),
    }))
    .filter((quote) => quote.symbol && quote.labels.length);
  const targetSymbol = matches[0]?.symbol || "";

  if (!matches.length) {
    return {
      title: "No MTF alerts",
      body: "No symbols are on MTF clouds now.",
      badgeCount: 0,
      tag: "mtf-empty",
      targetSymbol: "",
      url: "/",
    };
  }

  if (matches.length === 1) {
    const [match] = matches;
    const firstLabel = match.labels[0];
    return {
      title: `${match.symbol}: ${firstLabel}`,
      body: match.labels.length > 1 ? match.labels.slice(1).join(" + ") : "Tap to open this MTF row.",
      badgeCount: 1,
      tag: `mtf-${match.symbol}`,
      targetSymbol: match.symbol,
      url: mtfUrl(match.symbol),
    };
  }

  const symbols = matches.map((match) => match.symbol);
  return {
    title: `${matches.length} MTF alerts: ${symbols.slice(0, 3).join(", ")}${symbols.length > 3 ? "..." : ""}`,
    body: matches.slice(0, 3).map((match) => `${match.symbol} ${match.labels[0]}`).join(" • "),
    badgeCount: matches.length,
    tag: "mtf-batch",
    targetSymbol,
    url: mtfUrl(targetSymbol),
  };
}

function mtfUrl(symbol) {
  return symbol ? `/?mtf=${encodeURIComponent(symbol)}` : "/";
}

function scannerNotificationDetails(enteredRows, exitedRows) {
  const enteredSymbols = enteredRows.map((row) => row.symbol);
  const exitedSymbols = exitedRows.map((row) => row.symbol);
  const total = enteredRows.length + exitedRows.length;
  const primary = enteredRows[0] || exitedRows[0] || null;
  const enteredText = enteredRows.slice(0, 3).map(scannerRowText).join(" • ");
  const exitedText = exitedRows.slice(0, 3).map(scannerExitText).join(" • ");
  const bodyParts = [enteredText, exitedText].filter(Boolean);

  if (total === 1 && primary) {
    const entered = enteredRows.length === 1;
    return {
      title: `${primary.symbol} ${entered ? "entered" : "left"} Pre Market Scanner`,
      body: entered ? scannerRowText(primary) : scannerExitText(primary),
      badgeCount: 1,
      tag: `scanner-${entered ? "in" : "out"}-${primary.symbol}-${primary.action}`,
      targetSymbol: primary.symbol,
      url: "/",
    };
  }

  return {
    title: `${total} scanner changes`,
    body: bodyParts.join(" | ") || "Pre Market Scanner changed.",
    badgeCount: total,
    tag: "scanner-changes",
    targetSymbol: primary?.symbol || "",
    url: "/",
    enteredSymbols,
    exitedSymbols,
  };
}

function scannerRowText(row) {
  return `${row.symbol} ${row.action} ${row.trigger} @ ${formatPrice(row.price)}`;
}

function scannerExitText(row) {
  return `${row.symbol} left ${row.action} ${row.trigger}`;
}

function quotesWithMatchStatus(quotes, status) {
  return quotes
    .map((quote) => ({
      ...quote,
      mtf_matches: (quote.mtf_matches || []).filter((match) => (match.status || "confirmed") === status),
    }))
    .filter((quote) => quote.mtf_matches.length);
}

function alertableMtfQuotes(quotes) {
  return quotes
    .map((quote) => ({
      ...quote,
      mtf_matches: (quote.mtf_matches || []).filter((match) => (match.status || "confirmed") === "confirmed"),
    }))
    .filter((quote) => quote.mtf_matches.length);
}

function quotesWithTradeAction(quotes, action) {
  return quotes
    .map((quote) => splitMtfQuoteByAction(quote, action))
    .filter(Boolean);
}

function loadRiskSettings() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(RISK_SETTINGS_KEY) || "{}");
    return normalizeRiskSettings(saved);
  } catch {
    return normalizeRiskSettings({});
  }
}

function normalizeRiskSettings(settings) {
  const riskAmount = Number(settings?.riskAmount);
  const fixedStopBuffer = Number(settings?.fixedStopBuffer);
  const stopMode = settings?.stopMode === "auto" ? "auto" : "fixed";
  return {
    riskAmount: Number.isFinite(riskAmount) ? clamp(riskAmount, 1, 10000) : 100,
    stopMode,
    fixedStopBuffer: Number.isFinite(fixedStopBuffer) ? clamp(fixedStopBuffer, 0.05, 25) : 1,
  };
}

function saveRiskSettings(settings) {
  window.localStorage.setItem(RISK_SETTINGS_KEY, JSON.stringify(settings));
}

function loadAutoTradeSettings() {
  const defaults = defaultAutoTradeStrategies();
  try {
    const saved = JSON.parse(window.localStorage.getItem(AUTO_TRADE_KEY) || "{}");
    return {
      enabled: Boolean(saved?.enabled),
      strategies: { ...defaults, ...(saved?.strategies || {}) },
    };
  } catch {
    return { enabled: false, strategies: defaults };
  }
}

function saveAutoTradeSettings(settings) {
  window.localStorage.setItem(AUTO_TRADE_KEY, JSON.stringify({
    enabled: Boolean(settings.enabled),
    strategies: { ...defaultAutoTradeStrategies(), ...(settings.strategies || {}) },
  }));
}

function defaultAutoTradeStrategies() {
  return Object.fromEntries(ALERT_STRATEGIES.filter((strategy) => !strategy.scannerOnly).map((strategy) => [strategy.id, false]));
}

function loadAutoTradeExecutions() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(AUTO_TRADE_EXECUTIONS_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter(Boolean).slice(0, MAX_AUTO_TRADE_EXECUTIONS) : [];
  } catch {
    return [];
  }
}

function saveAutoTradeExecutions(keys) {
  window.localStorage.setItem(AUTO_TRADE_EXECUTIONS_KEY, JSON.stringify([...keys].slice(-MAX_AUTO_TRADE_EXECUTIONS)));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatDateTime(value) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  const date = parsed.toLocaleDateString([], { month: "short", day: "numeric" });
  const time = parsed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${date} ${time}`;
}

function loadAlertLog() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(ALERT_LOG_KEY) || "[]");
    return Array.isArray(saved) ? normalizeAlertHistoryItems(saved) : [];
  } catch {
    return [];
  }
}

function saveAlertLog(items) {
  window.localStorage.setItem(ALERT_LOG_KEY, JSON.stringify(normalizeAlertHistoryItems(items).slice(0, MAX_ALERT_LOG)));
}

function normalizeAlertHistoryItems(items) {
  const byId = new Map();
  for (const item of items || []) {
    const normalized = normalizeAlertHistoryItem(item);
    if (normalized && isNotificationHistoryItem(normalized)) byId.set(normalized.id, normalized);
  }
  return [...byId.values()]
    .sort((left, right) => alertHistoryTimestamp(right) - alertHistoryTimestamp(left))
    .slice(0, MAX_ALERT_LOG);
}

function normalizeAlertHistoryItem(item) {
  if (!item || typeof item !== "object") return null;
  const createdAt = item.createdAt || item.created_at || item.alertedAt || new Date().toISOString();
  const symbol = String(item.symbol || "").trim().toUpperCase();
  const title = String(item.title || item.reason || item.label || "Alert triggered");
  const body = String(item.body || item.message || item.reason || "");
  return {
    ...item,
    id: String(item.id || `${createdAt}:${symbol}:${title}`),
    createdAt,
    alertedAt: item.alertedAt || createdAt,
    kind: item.kind || "alert",
    title,
    body,
    symbol,
    reason: String(item.reason || body || title),
    action: item.action || "",
    watchlistName: item.watchlistName || item.watchlist_name || item.watchlistId || "",
    status: item.status || "triggered",
  };
}

function alertHistoryTimestamp(item) {
  const parsed = new Date(item.alertedAt || item.createdAt || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function alertHistoryDedupeKey(item) {
  return item.id || `${item.symbol}:${item.title}:${item.body}:${item.alertedAt}`;
}

function alertHistoryNotification(item) {
  return {
    id: `history-${item.id}`,
    title: item.title || item.reason || "Alert triggered",
    message: item.body || item.reason || item.label || "",
    kind: item.kind || "history",
    read: true,
    createdAt: item.alertedAt || item.createdAt,
  };
}

function isNotificationHistoryItem(item) {
  const kind = String(item.kind || "").toLowerCase();
  if (["notification", "push"].includes(kind)) return true;
  if (["server-push", "app-notification", "service-worker"].includes(String(item.source || ""))) return true;
  return Boolean(item.title || item.body) && !item.action && !item.outcome && item.targetPrice == null && item.stopPrice == null;
}

function notificationHistoryEntry({ title, message, kind = "notification", symbol = "", source = "app-notification", payload = null }) {
  const createdAt = new Date().toISOString();
  const normalizedSymbol = String(symbol || payload?.targetSymbol || payload?.target_symbol || "").trim().toUpperCase();
  return {
    id: `${createdAt}:${source}:${normalizedSymbol}:${title}`,
    createdAt,
    alertedAt: createdAt,
    kind: kind === "push" ? "push" : "notification",
    source,
    title,
    body: message || "",
    symbol: normalizedSymbol,
    reason: message || title,
    payload,
  };
}

function autoTradeKey(tab, symbol, match) {
  const tradeDate = String(match.candle_time || new Date().toISOString()).slice(0, 10);
  return `${tab}:${symbol}:${strategyIdForMatch(match)}:${tradeDate}`;
}

function autoLongTradePlan(tab, quote, riskSettings, autoTradeSettings) {
  const match = (quote.mtf_matches || []).find((item) => (
    (item.status || "confirmed") === "confirmed"
    && item.trade_action === "Long"
    && autoTradeSettings?.strategies?.[strategyIdForMatch(item)] === true
  ));
  if (!match) return null;

  const outcomePlan = alertOutcomePlan(match, quote.price, riskSettings);
  const entry = outcomePlan?.entry;
  const stop = outcomePlan?.stop;
  const target = outcomePlan?.target;
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || stop >= entry) return null;
  if (!Number.isFinite(target) || target <= entry) return null;
  const quantity = Number(match.risk_plan?.shares);
  if (!Number.isInteger(quantity) || quantity < 1) return null;

  return {
    key: autoTradeKey(tab, quote.symbol, match),
    quantity,
    entry: roundMoney(entry),
    stop: roundMoney(stop),
    target: roundMoney(target),
    setup: displayMtfLabel(match),
    candleTime: match.candle_time || "",
  };
}

function canAutoTradeWatchlist(watchlist) {
  return watchlist?.autoTradeEnabled !== false;
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

function alertOutcomePlan(match, fallbackPrice, riskSettings) {
  const action = match.trade_action;
  const entry = Number(matchEntryPrice(match) ?? fallbackPrice);
  if (!Number.isFinite(entry) || !["Long", "Short"].includes(action)) return null;
  const riskPlan = match.risk_plan || null;
  const cloudLow = Number((action === "Long" ? match.stop_cloud_low : null) ?? match.low ?? match.cloud_low);
  const cloudHigh = Number(match.high ?? match.cloud_high);
  const fixedBuffer = Number(riskSettings?.fixedStopBuffer || 1);
  const stop = riskPlan?.stop != null
    ? Number(riskPlan.stop)
    : action === "Long"
      ? cloudLow - fixedBuffer
      : cloudHigh + fixedBuffer;
  if (!Number.isFinite(stop)) return null;
  const risk = Math.abs(entry - stop);
  if (!Number.isFinite(risk) || risk <= 0) return null;
  return {
    entry: roundMoney(entry),
    stop: roundMoney(stop),
    target: roundMoney(action === "Long" ? entry + risk : entry - risk),
  };
}

function preMarketScannerRowsFromWatchlists(watchlists, quotesByTab) {
  const rowsBySymbol = new Map();
  for (const watchlist of watchlists) {
    for (const quote of quotesByTab[watchlist.id] || []) {
      const price = Number(quote.scanner_price ?? quote.price);
      const previousHigh = Number(quote.previous_day?.high);
      const previousLow = Number(quote.previous_day?.low);
      if (!Number.isFinite(price) || !Number.isFinite(previousHigh) || !Number.isFinite(previousLow)) continue;
      const trend = cloudStatus(quote.ema_10m, ["5", "12"], ["34", "50"]);
      const action = price > previousHigh && trend === "Bullish" ? "Long" : price < previousLow && trend === "Bearish" ? "Short" : "";
      if (!action || rowsBySymbol.has(quote.symbol)) continue;
      rowsBySymbol.set(quote.symbol, {
        symbol: quote.symbol,
        action,
        trend,
        price,
        previousHigh,
        previousLow,
        trigger: price > previousHigh ? "Above YH" : "Below YL",
        distancePct: price > previousHigh
          ? ((price - previousHigh) / previousHigh) * 100
          : ((previousLow - price) / previousLow) * 100,
        watchlistName: watchlist.name,
      });
    }
  }
  return [...rowsBySymbol.values()].sort((left, right) => (
    scannerTrendRank(left.trend) - scannerTrendRank(right.trend)
    || right.distancePct - left.distancePct
    || left.symbol.localeCompare(right.symbol)
  ));
}

function scannerTrendRank(trend) {
  if (trend === "Bullish") return 0;
  if (trend === "Bearish") return 1;
  return 2;
}

export default function App() {
  const [watchlists, setWatchlists] = useState(loadWatchlists);
  const [scannerWatchlistIds, setScannerWatchlistIds] = useState(() => loadScannerWatchlistIds(loadWatchlists()));
  const [status, setStatus] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [accountCount, setAccountCount] = useState(0);
  const [accountsConfirmedAt, setAccountsConfirmedAt] = useState(null);
  const [selectedAccountId, setSelectedAccountId] = useState(null);
  const [quotesByTab, setQuotesByTab] = useState(() => initialTabState(loadWatchlists(), []));
  const [updatedTextByTab, setUpdatedTextByTab] = useState(() => initialTabState(loadWatchlists(), "Webull polling stopped"));
  const [alert, setAlert] = useState("");
  const [alertKind, setAlertKind] = useState("info");
  const [liveAlert, setLiveAlert] = useState("");
  const [notificationState, setNotificationState] = useState({
    supported: false,
    permission: "default",
    webPushConfigured: false,
    subscribed: false,
    appEnabled: true,
  });
  const [notifications, setNotifications] = useState([]);
  const [alertLog, setAlertLog] = useState(loadAlertLog);
  const [retainedMtfQuotesByTab, setRetainedMtfQuotesByTab] = useState(loadRetainedMtfQuotes);
  const [activePage, setActivePage] = useState(() => {
    if (window.location.hash === "#alerts") return "alerts";
    if (window.location.hash === "#mtfs") return "mtfs";
    if (window.location.hash === "#trades") return "trades";
    return "home";
  });
  const [autoTradeOrders, setAutoTradeOrders] = useState(() => emptyAutoTradeOrders());
  const [autoTradeAlert, setAutoTradeAlert] = useState("");
  const [strategyState, setStrategyState] = useState(loadStrategyState);
  const [riskSettings, setRiskSettings] = useState(loadRiskSettings);
  const [autoTrade, setAutoTrade] = useState(loadAutoTradeSettings);
  const [watchlistTab, setWatchlistTab] = useState(OG_WATCHLIST_ID);
  const [symbolInputs, setSymbolInputs] = useState({});
  const [newMtfRows, setNewMtfRows] = useState({});
  const [focusedMtfSymbol, setFocusedMtfSymbol] = useState("");
  const [buyState, setBuyState] = useState({});
  const [loading, setLoading] = useState({
    shell: false,
    watchlists: false,
    prices: false,
    notifications: false,
    trades: false,
  });
  const passiveMarketTimer = useRef(null);
  const lastMtfSignature = useRef(initialTabState(loadWatchlists(), null));
  const lastMtfRows = useRef(initialTabState(loadWatchlists(), {}));
  const lastScannerRows = useRef(null);
  const strategyStateRef = useRef(strategyState);
  const riskSettingsRef = useRef(riskSettings);
  const autoTradeRef = useRef(autoTrade);
  const autoTradeExecutionsRef = useRef(new Set(loadAutoTradeExecutions()));
  const alertLogRef = useRef(alertLog);
  const selectedAccountIdRef = useRef(selectedAccountId);
  const accountsRef = useRef(accounts);
  const accountsConfirmedRef = useRef(false);
  const watchlistTabRef = useRef(watchlistTab);
  const watchlistsRef = useRef(watchlists);
  const retainedMtfQuotesRef = useRef(retainedMtfQuotesByTab);
  const activeWatchlist = watchlists.find((item) => item.id === watchlistTab) || watchlists[0];
  const contextWatchlist = activeWatchlist || watchlists[0];
  const quotes = quotesByTab[contextWatchlist?.id] || [];
  const updatedText = updatedTextByTab[contextWatchlist?.id] || "";
  const pageLoading = loading.shell || loading.watchlists || loading.prices || loading.notifications || loading.trades;
  const tradingAccountId = useMemo(() => marginTradingAccountId(accounts, selectedAccountId), [accounts, selectedAccountId]);

  const trendBuckets = useMemo(() => {
    return quotes.reduce(
      (buckets, quote) => {
        const trend = cloudStatus(quote.ema_10m, ["5", "12"], ["34", "50"]);
        if (trend === "Bullish") buckets.bullish.push(quote);
        else if (trend === "Bearish") buckets.bearish.push(quote);
        else if (trend === "Chop") buckets.chop.push(quote);
        return buckets;
      },
      { bullish: [], bearish: [], chop: [] },
    );
  }, [quotes]);
  const scannerWatchlists = useMemo(() => {
    const selectedIds = new Set(scannerWatchlistIds);
    return watchlists.filter((watchlist) => selectedIds.has(watchlist.id));
  }, [scannerWatchlistIds, watchlists]);
  const preMarketScannerRows = useMemo(() => preMarketScannerRowsFromWatchlists(scannerWatchlists, quotesByTab), [scannerWatchlists, quotesByTab]);
  const scannerLongCount = useMemo(() => preMarketScannerRows.filter((row) => row.action === "Long").length, [preMarketScannerRows]);
  const scannerShortCount = useMemo(() => preMarketScannerRows.filter((row) => row.action === "Short").length, [preMarketScannerRows]);
  const allMtfQuotes = useMemo(() => {
    const matches = watchlists.flatMap((watchlist) => (
      (quotesByTab[watchlist.id] || [])
        .filter((quote) => quote.mtf_matches?.length)
        .map((quote) => ({
          ...quote,
          watchlist_id: watchlist.id,
          watchlist_name: watchlist.name,
          is_new: Boolean(newMtfRows[mtfRowId(watchlist.id, quote.symbol)]),
        }))
    ));
    return filterQuotesByStrategy(matches, strategyState);
  }, [newMtfRows, quotesByTab, strategyState, watchlists]);
  const allMtfs = useMemo(() => quotesWithMatchStatus(allMtfQuotes, "confirmed"), [allMtfQuotes]);
  const longMtfs = useMemo(() => quotesWithTradeAction(allMtfs, "Long"), [allMtfs]);
  const shortMtfs = useMemo(() => quotesWithTradeAction(allMtfs, "Short"), [allMtfs]);
  const enabledStrategyCount = useMemo(
    () => Object.values(strategyState || {}).filter((enabled) => enabled !== false).length,
    [strategyState],
  );
  const autoLongEnabledCount = useMemo(
    () => ALERT_STRATEGIES.filter((strategy) => !strategy.scannerOnly && autoTrade.strategies?.[strategy.id]).length,
    [autoTrade.strategies],
  );
  const unreadNotificationCount = useMemo(() => notifications.filter((item) => !item.read).length, [notifications]);
  const bellNotifications = useMemo(() => {
    const localItems = notifications.slice(0, MAX_NOTIFICATIONS);
    const historyItems = alertLog.slice(0, MAX_NOTIFICATIONS).map(alertHistoryNotification);
    const seen = new Set(localItems.map((item) => item.id));
    return [
      ...localItems,
      ...historyItems.filter((item) => !seen.has(item.id)),
    ].slice(0, MAX_NOTIFICATIONS);
  }, [alertLog, notifications]);

  async function refreshShell() {
    setLoadingKey("shell", true);
    try {
      const accountResponse = await getJson("/api/accounts");
      if (!accountResponse.ok) {
        setAppAlert(accountErrorText(accountResponse), "error");
        setAccounts([]);
        setAccountCount(0);
        setAccountsConfirmedAt(null);
        setSelectedAccountId(null);
        accountsConfirmedRef.current = false;
        return false;
      }
      const nextAccounts = flattenAccounts(accountResponse.data);
      setAccounts(nextAccounts);
      setAccountCount(accountResponse.account_count ?? nextAccounts.length);
      setSelectedAccountId((current) => preferredAccountId(nextAccounts, current));
      accountsConfirmedRef.current = nextAccounts.length > 0;
      if (!nextAccounts.length) {
        setAccountsConfirmedAt(null);
        setAppAlert("Webull account endpoint responded, but returned zero accounts.", "warning");
        return false;
      }

      const nextStatus = await getJson("/api/status");
      setStatus(nextStatus);
      if (!nextStatus.configured) {
        setAppAlert("Add WEBULL_APP_KEY and WEBULL_APP_SECRET to .env, then restart the server.", "error");
        accountsConfirmedRef.current = false;
        setAccountsConfirmedAt(null);
        return false;
      }
      setAccountsConfirmedAt(new Date().toISOString());
      setAppAlert(`Webull account API confirmed ${accountResponse.account_count ?? nextAccounts.length} account${(accountResponse.account_count ?? nextAccounts.length) === 1 ? "" : "s"}.`, "success");
      return true;
    } catch (error) {
      setAppAlert(error.message, "error");
      accountsConfirmedRef.current = false;
      setAccountsConfirmedAt(null);
      return false;
    } finally {
      setLoadingKey("shell", false);
    }
  }

  function accountErrorText(response) {
    if (response.webull_guard_active) {
      const until = response.webull_guard_blocked_until
        ? ` until ${new Date(response.webull_guard_blocked_until).toLocaleString()}`
        : "";
      return `Webull account login is paused${until}: ${response.error}`;
    }
    return response.error || `Webull returned ${response.status_code}`;
  }

  function setAppAlert(message, kind = "info") {
    setAlert(message);
    setAlertKind(kind);
  }

  async function refreshWatchlists({ showLoading = true } = {}) {
    if (!accountsConfirmedRef.current) return null;
    if (showLoading) setLoadingKey("watchlists", true);
    try {
      const payload = await getJson("/api/webull/watchlists");
      const serverWatchlists = normalizeWatchlists(payload.watchlists || []);
      const localWatchlists = loadWatchlists();
      if (shouldPromoteLocalWatchlists(serverWatchlists, localWatchlists)) {
        const saved = await postJson("/api/webull/watchlists", { watchlists: localWatchlists });
        const next = normalizeWatchlists(saved.watchlists || localWatchlists);
        saveWatchlists(next);
        applyWatchlists(next);
        return;
      }
      const next = serverWatchlists;
      saveWatchlists(next);
      applyWatchlists(next);
      return next;
    } catch (error) {
      setLiveAlert(error.message);
      return null;
    } finally {
      if (showLoading) setLoadingKey("watchlists", false);
    }
  }

  async function loadAlertHistory({ showLoading = false } = {}) {
    if (!accountsConfirmedRef.current) return;
    if (showLoading) setLoadingKey("notifications", true);
    try {
      const payload = await getJson("/api/notifications/history?limit=500");
      const serverItems = normalizeAlertHistoryItems(payload.items || []);
      const localItems = normalizeAlertHistoryItems(alertLogRef.current);
      const merged = normalizeAlertHistoryItems([...serverItems, ...localItems]);
      alertLogRef.current = merged;
      setAlertLog(merged);
      saveAlertLog(merged);
      const serverIds = new Set(serverItems.map((item) => item.id));
      const localOnly = merged.filter((item) => !serverIds.has(item.id));
      if (localOnly.length) {
        postJson("/api/notifications/history", { items: localOnly }).catch(() => {});
      }
    } catch (error) {
      setLiveAlert(error.message);
    } finally {
      if (showLoading) setLoadingKey("notifications", false);
    }
  }

  async function refreshAllPrices({ showLoading = true } = {}) {
    if (!accountsConfirmedRef.current) {
      setLiveAlert("Confirm Webull accounts before starting market data refresh.");
      return;
    }
    setLiveAlert("");
    if (showLoading) setLoadingKey("prices", true);
    try {
      await refreshWatchlistBatch(watchlistsRef.current);
    } catch (error) {
      setLiveAlert(error.message);
    } finally {
      if (showLoading) setLoadingKey("prices", false);
    }
  }

  async function refreshScannerPrices({ showLoading = true } = {}) {
    if (!accountsConfirmedRef.current) {
      setLiveAlert("Confirm Webull accounts before starting market data refresh.");
      return;
    }
    setLiveAlert("");
    if (showLoading) setLoadingKey("prices", true);
    try {
      const selectedIds = new Set(scannerWatchlistIds);
      const lists = watchlistsRef.current.filter((watchlist) => selectedIds.has(watchlist.id));
      if (!lists.length) {
        setLiveAlert("Select a list for the scanner.");
        return;
      }
      await refreshWatchlistBatch(lists);
    } catch (error) {
      setLiveAlert(error.message);
    } finally {
      if (showLoading) setLoadingKey("prices", false);
    }
  }

  async function refreshScannerWatchlist(id) {
    if (!accountsConfirmedRef.current) {
      setLiveAlert("Confirm Webull accounts before starting market data refresh.");
      return;
    }
    const watchlist = watchlistsRef.current.find((item) => item.id === id);
    if (!watchlist) return;
    setLiveAlert("");
    setLoadingKey("prices", true);
    try {
      await refreshWatchlistPrices(watchlist);
    } catch (error) {
      setLiveAlert(error.message);
    } finally {
      setLoadingKey("prices", false);
    }
  }

  async function refreshWatchlistBatch(lists) {
    let index = 0;
    const errors = [];
    const workerCount = Math.min(WATCHLIST_REFRESH_CONCURRENCY, lists.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (index < lists.length) {
        const watchlist = lists[index];
        index += 1;
        try {
          await refreshWatchlistPrices(watchlist);
        } catch (error) {
          errors.push(error);
        }
      }
    });
    await Promise.all(workers);
    if (errors.length) {
      throw errors[0];
    }
  }

  async function refreshAutoTrades({ showLoading = true } = {}) {
    if (!accountsConfirmedRef.current) {
      setAutoTradeOrders(emptyAutoTradeOrders());
      setAutoTradeAlert("Confirm Webull accounts before loading trades.");
      return;
    }
    const accountId = tradingAccountId;
    setAutoTradeAlert("");
    if (!accountId) {
      setAutoTradeOrders(emptyAutoTradeOrders());
      setAutoTradeAlert("Select a Webull margin account to view trades.");
      return;
    }
    if (showLoading) setLoadingKey("trades", true);
    try {
      const payload = await getJson(`/api/account/${accountId}/auto-trades?page_size=50&days=1`);
      if (!payload.ok) {
        setAutoTradeAlert(payload.history?.error || payload.open_orders?.error || `Webull returned order data with errors.`);
      }
      setAutoTradeOrders(payload);
    } catch (error) {
      setAutoTradeOrders(emptyAutoTradeOrders());
      setAutoTradeAlert(error.message);
    } finally {
      if (showLoading) setLoadingKey("trades", false);
    }
  }

  async function refreshWatchlistPrices(watchlist) {
    if (!accountsConfirmedRef.current) return;
    if (!watchlist) return;
    const selectedSymbols = watchlist.symbols || [];
    if (!selectedSymbols.length) {
      setQuotesForTab(watchlist.id, []);
      setUpdatedTextForTab(watchlist.id, "Add symbols to this list");
      return;
    }
    const settings = riskSettingsRef.current;
    const query = new URLSearchParams({
      symbols: selectedSymbols.join(","),
      risk_amount: String(settings.riskAmount),
      stop_mode: settings.stopMode,
      fixed_stop_buffer: String(settings.fixedStopBuffer),
    });
    const payload = await getJson(`/api/webull/live-prices?${query.toString()}`);
    if (!payload.ok) {
      const errorText = livePriceErrorText(payload);
      setUpdatedTextForTab(watchlist.id, errorText.status);
      setLiveAlert(errorText.alert);
      return;
    }
    const nextQuotes = payload.quotes || [];
    const currentMtfs = filterQuotesByStrategy(alertableMtfQuotes(nextQuotes), strategyStateRef.current);
    const updatedAt = new Date().toLocaleTimeString();
    retainedMtfQuotesRef.current = {};
    setRetainedMtfQuotesByTab({});
    clearRetainedMtfQuotes();
    setQuotesForTab(watchlist.id, nextQuotes);
    setUpdatedTextForTab(watchlist.id, `Updated ${updatedAt} from ${payload.source || "webull"}`);
    notifyMtfUpdate(watchlist.id, currentMtfs);

    if (payload.errors?.length) {
      setLiveAlert(`Some data failed: ${payload.errors.map((item) => item.source).join(", ")}`);
    }
  }

  function livePriceErrorText(payload) {
    const firstError = payload.errors?.map((item) => item.error).find(Boolean);
    const guardUntil = firstError?.webull_guard_blocked_until;
    const guardSuffix = guardUntil ? ` until ${new Date(guardUntil).toLocaleString()}` : "";
    if (firstError?.webull_guard_active) {
      return {
        status: "Webull polling blocked",
        alert: `Webull polling is paused${guardSuffix}: ${firstError.error}`,
      };
    }
    return {
      status: "Webull polling failed",
      alert: firstError?.error || "Webull live prices returned no fresh data.",
    };
  }

  function setQuotesForTab(tab, nextQuotes) {
    setQuotesByTab((current) => ({ ...current, [tab]: nextQuotes }));
  }

  function setUpdatedTextForTab(tab, text) {
    setUpdatedTextByTab((current) => ({ ...current, [tab]: text }));
  }

  function notifyMtfUpdate(tab, nextMtfs) {
    const signature = mtfSignature(nextMtfs);
    const previousSignature = lastMtfSignature.current[tab];
    const previousRows = lastMtfRows.current[tab] || {};
    const nextRows = Object.fromEntries(nextMtfs.map((quote) => [quote.symbol, mtfRowSignature(quote)]));
    const hasMatches = nextMtfs.length > 0;
    const firstMatchLoad = previousSignature === null && hasMatches;
    const changed = previousSignature !== null && signature !== previousSignature;
    lastMtfSignature.current = { ...lastMtfSignature.current, [tab]: signature };
    lastMtfRows.current = { ...lastMtfRows.current, [tab]: nextRows };
    if (!firstMatchLoad && !changed) return;

    const freshQuotes = nextMtfs.filter((quote) => previousRows[quote.symbol] !== nextRows[quote.symbol]);
    const freshRowIds = freshQuotes.map((quote) => mtfRowId(tab, quote.symbol));
    if (freshRowIds.length) {
      setNewMtfRows((current) => ({
        ...current,
        ...Object.fromEntries(freshRowIds.map((id) => [id, true])),
      }));
    }

    const notification = mtfNotificationDetails(nextMtfs);
    appendAlertLog([
      notificationHistoryEntry({
        title: notification.title,
        message: notification.body,
        kind: "notification",
        symbol: notification.targetSymbol,
        payload: notification,
      }),
    ]);
    addNotification({
      title: notification.title,
      message: notification.body,
      kind: "changed",
    });
    showMtfDeviceNotification(notification);
    if (changed) autoBuyLongAlerts(tab, freshQuotes);
  }

  function notifyScannerUpdate(nextRows) {
    const nextByKey = Object.fromEntries(nextRows.map((row) => [scannerRowKey(row), row]));
    if (strategyStateRef.current?.[SCANNER_ALERT_STRATEGY_ID] === false) {
      lastScannerRows.current = nextByKey;
      return;
    }
    const previousByKey = lastScannerRows.current;
    lastScannerRows.current = nextByKey;
    if (previousByKey === null) {
      return;
    }

    const enteredRows = nextRows.filter((row) => !previousByKey[scannerRowKey(row)]);
    const exitedRows = Object.values(previousByKey).filter((row) => !nextByKey[scannerRowKey(row)]);
    if (!enteredRows.length && !exitedRows.length) return;

    const notification = scannerNotificationDetails(enteredRows, exitedRows);
    publishScannerNotification(notification);
  }

  function publishScannerNotification(notification) {
    appendAlertLog([
      notificationHistoryEntry({
        title: notification.title,
        message: notification.body,
        kind: "notification",
        symbol: notification.targetSymbol,
        source: "scanner",
        payload: notification,
      }),
    ]);
    addNotification({
      title: notification.title,
      message: notification.body,
      kind: "scanner",
    });
    showScannerDeviceNotification(notification);
  }

  function appendAlertLog(entries) {
    if (!entries.length) return;
    setAlertLog((current) => {
      const normalizedEntries = normalizeAlertHistoryItems(entries);
      const seen = new Set(current.map(alertHistoryDedupeKey));
      const freshEntries = normalizedEntries.filter((item) => !seen.has(alertHistoryDedupeKey(item)));
      if (!freshEntries.length) return current;
      const next = normalizeAlertHistoryItems([...freshEntries, ...current]);
      alertLogRef.current = next;
      saveAlertLog(next);
      postJson("/api/notifications/history", { items: freshEntries }).catch(() => {});
      return next;
    });
  }

  function clearAlertLog() {
    alertLogRef.current = [];
    setAlertLog([]);
    saveAlertLog([]);
    deleteJson("/api/notifications/history").catch((error) => setLiveAlert(error.message));
  }

  function navigatePage(page) {
    setActivePage(page);
    const hash = page === "alerts" ? "#alerts" : page === "mtfs" ? "#mtfs" : page === "trades" ? "#trades" : "";
    window.history.replaceState(null, "", hash || window.location.pathname);
  }

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

  function setLoadingKey(key, value) {
    setLoading((current) => ({ ...current, [key]: value }));
  }

  function dismissNewMtfRow(tab, symbol) {
    const id = mtfRowId(tab, symbol);
    setNewMtfRows((current) => {
      if (!current[id]) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }

  function focusMtfSymbol(symbol) {
    const normalized = String(symbol || "").trim().toUpperCase();
    if (!normalized) return;
    setFocusedMtfSymbol(normalized);
    const url = new URL(window.location.href);
    url.searchParams.set("mtf", normalized);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  async function buyMtfQuote(quote) {
    const symbol = quote.symbol;
    const accountId = marginTradingAccountId(accounts, selectedAccountId);
    if (!accountId) {
      setLiveAlert("Select a Webull margin account before buying.");
      return;
    }
    if (quote.mtf_matches?.some((match) => match.trade_action === "Short")) {
      setLiveAlert(`${symbol} is a short signal. Short order placement is not wired yet.`);
      return;
    }
    const limitPrice = Number(quote.price);
    if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
      setLiveAlert(`${symbol} does not have a valid limit price yet. Refresh prices and try again.`);
      return;
    }
    const confirmed = window.confirm(
      `Buy 1 share of ${symbol} in account ${accountId} with a ${formatPrice(limitPrice)} limit order?`
    );
    if (!confirmed) return;

    setBuyState((current) => ({ ...current, [symbol]: { status: "loading" } }));
    try {
      const payload = await postJson("/api/trade/buy", { account_id: accountId, symbol, limit_price: limitPrice });
      if (!payload.ok) {
        throw new Error(payload.error || payload.preview?.error || payload.place?.error || `Webull rejected ${symbol} buy order.`);
      }
      setBuyState((current) => ({ ...current, [symbol]: { status: "ok" } }));
      setLiveAlert(`Submitted ${formatPrice(limitPrice)} limit buy order for 1 share of ${symbol}.`);
    } catch (error) {
      setBuyState((current) => ({ ...current, [symbol]: { status: "error" } }));
      setLiveAlert(error.message);
    }
  }

  async function autoBuyLongAlerts(tab, quotes) {
    if (!autoTradeRef.current.enabled) return;
    const watchlist = watchlistsRef.current.find((item) => item.id === tab);
    if (!canAutoTradeWatchlist(watchlist)) return;
    const accountId = marginTradingAccountId(accountsRef.current, selectedAccountIdRef.current);
    if (!accountId) {
      addNotification({
        title: "Auto-buy skipped",
        message: "Select a Webull margin account before enabling auto-buy.",
        kind: "system",
      });
      return;
    }

    for (const quote of quotes) {
      const plan = autoLongTradePlan(tab, quote, riskSettingsRef.current, autoTradeRef.current);
      if (!plan || autoTradeExecutionsRef.current.has(plan.key)) continue;
      autoTradeExecutionsRef.current.add(plan.key);
      saveAutoTradeExecutions(autoTradeExecutionsRef.current);
      setBuyState((current) => ({ ...current, [quote.symbol]: { status: "loading" } }));
      try {
        const payload = await postJson("/api/trade/auto-long", {
          account_id: accountId,
          symbol: quote.symbol,
          quantity: plan.quantity,
          entry_price: plan.entry,
          stop_price: plan.stop,
          target_price: plan.target,
          setup: plan.setup,
          candle_time: plan.candleTime,
        });
        if (!payload.ok) {
          throw new Error(payload.error || payload.preview?.error || payload.place?.error || `Webull rejected ${quote.symbol} auto-buy.`);
        }
        setBuyState((current) => ({ ...current, [quote.symbol]: { status: "ok" } }));
        addNotification({
          title: `Auto bought ${quote.symbol}`,
          message: `${plan.quantity} shares long @ ${formatPrice(plan.entry)}, target ${formatPrice(plan.target)}, SL ${formatPrice(plan.stop)}.`,
          kind: "trade",
        });
        if (activePage === "trades") refreshAutoTrades({ showLoading: false });
      } catch (error) {
        setBuyState((current) => ({ ...current, [quote.symbol]: { status: "error" } }));
        addNotification({
          title: `Auto-buy failed ${quote.symbol}`,
          message: error.message,
          kind: "trade",
        });
      }
    }
  }

  function updateAutoTradeSettings(nextSettings) {
    const normalized = {
      enabled: Boolean(nextSettings.enabled),
      strategies: { ...defaultAutoTradeStrategies(), ...(nextSettings.strategies || autoTradeRef.current.strategies || {}) },
    };
    setAutoTrade(normalized);
    autoTradeRef.current = normalized;
    saveAutoTradeSettings(normalized);
  }

  function toggleStrategy(strategyId) {
    setStrategyState((current) => {
      const next = { ...current, [strategyId]: current[strategyId] === false };
      saveStrategyState(next);
      return next;
    });
    lastMtfSignature.current = initialTabState(watchlistsRef.current, null);
  }

  function updateRiskSettings(nextSettings) {
    const normalized = normalizeRiskSettings(nextSettings);
    setRiskSettings(normalized);
    riskSettingsRef.current = normalized;
    saveRiskSettings(normalized);
    lastMtfSignature.current = initialTabState(watchlistsRef.current, null);
  }

  function addSymbolsToActiveWatchlist(event) {
    event.preventDefault();
    const incoming = normalizeSymbols([symbolInputs[watchlistTab] || ""]);
    if (!incoming.length) return;
    updateWatchlists((current) => current.map((watchlist) => (
      watchlist.id === watchlistTab
        ? { ...watchlist, symbols: normalizeSymbols([...watchlist.symbols, ...incoming]).slice(0, 25) }
        : watchlist
    )));
    setSymbolInputs((current) => ({ ...current, [watchlistTab]: "" }));
    lastMtfSignature.current = { ...lastMtfSignature.current, [watchlistTab]: null };
  }

  function removeSymbolFromWatchlist(symbol, tab = watchlistTab) {
    updateWatchlists((current) => current.map((watchlist) => (
      watchlist.id === tab
        ? { ...watchlist, symbols: watchlist.symbols.filter((item) => item !== symbol) }
        : watchlist
    )));
    setQuotesByTab((current) => ({
      ...current,
      [tab]: (current[tab] || []).filter((quote) => quote.symbol !== symbol),
    }));
    lastMtfSignature.current = { ...lastMtfSignature.current, [tab]: null };
    const tabRows = { ...(lastMtfRows.current[tab] || {}) };
    delete tabRows[symbol];
    lastMtfRows.current = { ...lastMtfRows.current, [tab]: tabRows };
    dismissNewMtfRow(tab, symbol);
  }

  function addWatchlist() {
    const name = window.prompt("Name this tab")?.trim();
    if (!name) return;
    const usedIds = new Set(watchlistsRef.current.map((item) => item.id));
    const id = uniqueId(slugify(name), usedIds);
    const nextWatchlist = { id, name, symbols: [], locked: false, autoTradeEnabled: true };
    updateWatchlists((current) => [...current, nextWatchlist]);
    setQuotesByTab((current) => ({ ...current, [id]: [] }));
    setUpdatedTextByTab((current) => ({ ...current, [id]: "Add symbols to this list" }));
    lastMtfSignature.current = { ...lastMtfSignature.current, [id]: null };
    setWatchlistTab(id);
  }

  function deleteWatchlist(id) {
    const watchlist = watchlists.find((item) => item.id === id);
    if (!watchlist || watchlist.locked) return;
    updateWatchlists((current) => current.filter((item) => item.id !== id));
    setQuotesByTab((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setUpdatedTextByTab((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setSymbolInputs((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    const nextSignatures = { ...lastMtfSignature.current };
    delete nextSignatures[id];
    lastMtfSignature.current = nextSignatures;
    const nextRows = { ...lastMtfRows.current };
    delete nextRows[id];
    lastMtfRows.current = nextRows;
    setNewMtfRows((current) => Object.fromEntries(
      Object.entries(current).filter(([rowId]) => !rowId.startsWith(`${id}:`)),
    ));
    if (watchlistTab === id) {
      setWatchlistTab(OG_WATCHLIST_ID);
    }
  }

  function switchWatchlistTab(tab) {
    setWatchlistTab(tab);
    setUpdatedTextByTab((current) => ({
      ...current,
      [tab]: current[tab] || "Watchlist selected",
    }));
  }

  function toggleScannerWatchlist(id) {
    setScannerWatchlistIds((current) => (
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id]
    ));
  }

  function selectAllScannerWatchlists() {
    setScannerWatchlistIds(watchlistsRef.current.map((watchlist) => watchlist.id));
  }

  function toggleWatchlistAutoTrade(id, autoTradeEnabled) {
    updateWatchlists((current) => current.map((watchlist) => (
      watchlist.id === id ? { ...watchlist, autoTradeEnabled } : watchlist
    )));
  }

  function updateWatchlists(updater) {
    const next = normalizeWatchlists(updater(watchlistsRef.current));
    saveWatchlists(next);
    applyWatchlists(next);
    setLoadingKey("watchlists", true);
    postJson("/api/webull/watchlists", { watchlists: next })
      .then((payload) => {
        const saved = normalizeWatchlists(payload.watchlists || next);
        saveWatchlists(saved);
        applyWatchlists(saved);
      })
      .catch((error) => setLiveAlert(error.message))
      .finally(() => setLoadingKey("watchlists", false));
  }

  function applyWatchlists(next) {
    setWatchlists(next);
    watchlistsRef.current = next;
    setQuotesByTab((current) => {
      const allowedIds = new Set(next.map((item) => item.id));
      const updated = {};
      for (const watchlist of next) {
        updated[watchlist.id] = current[watchlist.id] || [];
      }
      for (const id of Object.keys(current)) {
        if (allowedIds.has(id)) updated[id] = current[id];
      }
      return updated;
    });
    setUpdatedTextByTab((current) => {
      const updated = {};
      for (const watchlist of next) {
        updated[watchlist.id] = current[watchlist.id] || "Webull polling stopped";
      }
      return updated;
    });
    setWatchlistTab((current) => (next.some((item) => item.id === current) ? current : OG_WATCHLIST_ID));
  }

  async function refreshAppMarketData({ showLoading = true } = {}) {
    if (!accountsConfirmedRef.current) return;
    await refreshWatchlists({ showLoading });
    await refreshAllPrices({ showLoading });
  }

  function showMtfDeviceNotification(notification) {
    if (!notificationState.appEnabled || notificationState.permission !== "granted") return;
    showDeviceNotification({
      title: notification.title,
      body: notification.body,
      badgeCount: notification.badgeCount,
      tag: notification.tag,
      targetSymbol: notification.targetSymbol,
      url: notification.url,
    }).catch((error) => setLiveAlert(error.message));
  }

  function showScannerDeviceNotification(notification) {
    if (!notificationState.appEnabled || notificationState.permission !== "granted") return;
    showDeviceNotification({
      title: notification.title,
      body: notification.body,
      badgeCount: notification.badgeCount,
      tag: notification.tag,
      targetSymbol: notification.targetSymbol,
      url: notification.url,
    }).catch((error) => setLiveAlert(error.message));
  }

  async function enableAppNotifications() {
    setLoadingKey("notifications", true);
    try {
      const nextState = await enableNotifications(strategyState);
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

  async function retryNotificationCheck() {
    setLoadingKey("notifications", true);
    try {
      const payload = await postJson("/api/notifications/check", {});
      if (payload.notification) {
        addNotification({
          title: payload.notification.title || "MTF check sent",
          message: payload.notification.body || "Manual MTF notification check completed.",
          kind: "system",
        });
        loadAlertHistory({ showLoading: false });
      } else {
        addNotification({
          title: "MTF check complete",
          message: "No new notification changes found.",
          kind: "system",
        });
      }
    } catch (error) {
      setLiveAlert(error.message);
      addNotification({
        title: "MTF check paused",
        message: error.message,
        kind: "system",
      });
    } finally {
      setLoadingKey("notifications", false);
    }
  }

  function pauseBackgroundRefresh() {
    if (passiveMarketTimer.current) clearInterval(passiveMarketTimer.current);
    passiveMarketTimer.current = null;

    return () => {
      if (!accountsConfirmedRef.current) return;
      if (!passiveMarketTimer.current) {
        passiveMarketTimer.current = setInterval(() => {
          if (isMarketRefreshWindow()) refreshAppMarketData({ showLoading: false });
        }, PASSIVE_MARKET_REFRESH_INTERVAL_MS);
      }
    };
  }

  function startBackgroundRefresh() {
    if (!accountsConfirmedRef.current) return;
    if (!passiveMarketTimer.current) {
      passiveMarketTimer.current = setInterval(() => {
        if (isMarketRefreshWindow()) refreshAppMarketData({ showLoading: false });
      }, PASSIVE_MARKET_REFRESH_INTERVAL_MS);
    }
  }

  async function confirmAccountsAndStart() {
    const confirmed = await refreshShell();
    if (!confirmed) return;
    loadAlertHistory();
    loadNotificationState(strategyStateRef.current)
      .then(setNotificationState)
      .catch(() => {
        setNotificationState((current) => ({ ...current, supported: false }));
      });
    startBackgroundRefresh();
  }

  useEffect(() => {
    confirmAccountsAndStart();
    return () => {
      if (passiveMarketTimer.current) clearInterval(passiveMarketTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return undefined;
    function handleServiceWorkerMessage(event) {
      if (event.data?.type !== "MTF_PUSH_UPDATE") return;
      const targetSymbol = event.data.payload?.targetSymbol;
      if (targetSymbol) focusMtfSymbol(targetSymbol);
      addNotification({
        title: event.data.payload?.title || "Push alert received",
        message: event.data.payload?.body || "MTF push update received.",
        kind: "push",
      });
      appendAlertLog([
        notificationHistoryEntry({
          title: event.data.payload?.title || "Push alert received",
          message: event.data.payload?.body || "MTF push update received.",
          kind: "push",
          symbol: targetSymbol,
          source: "service-worker",
          payload: event.data.payload || null,
        }),
      ]);
      if (accountsConfirmedRef.current) {
        refreshAppMarketData({ showLoading: false });
        loadAlertHistory({ showLoading: false });
      }
    }

    navigator.serviceWorker.addEventListener("message", handleServiceWorkerMessage);
    return () => navigator.serviceWorker.removeEventListener("message", handleServiceWorkerMessage);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const symbol = params.get("mtf");
    if (symbol) {
      focusMtfSymbol(symbol);
      navigatePage("mtfs");
    }
  }, []);

  useEffect(() => {
    if (!focusedMtfSymbol || !allMtfs.some((quote) => quote.symbol === focusedMtfSymbol)) return;
    window.requestAnimationFrame(() => {
      document.querySelector(`[data-mtf-symbol="${focusedMtfSymbol}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [allMtfs, focusedMtfSymbol]);

  useEffect(() => {
    notifyScannerUpdate(preMarketScannerRows);
  }, [preMarketScannerRows]);

  useEffect(() => {
    const canBadge = notificationState.appEnabled && notificationState.permission === "granted";
    setAppBadgeCount(canBadge ? unreadNotificationCount : 0).catch(() => {});
  }, [notificationState.appEnabled, notificationState.permission, unreadNotificationCount]);

  useEffect(() => {
    alertLogRef.current = alertLog;
  }, [alertLog]);

  useEffect(() => {
    strategyStateRef.current = strategyState;
  }, [strategyState]);

  useEffect(() => {
    riskSettingsRef.current = riskSettings;
  }, [riskSettings]);

  useEffect(() => {
    autoTradeRef.current = autoTrade;
  }, [autoTrade]);

  useEffect(() => {
    selectedAccountIdRef.current = selectedAccountId;
  }, [selectedAccountId]);

  useEffect(() => {
    accountsRef.current = accounts;
  }, [accounts]);

  useEffect(() => {
    retainedMtfQuotesRef.current = retainedMtfQuotesByTab;
  }, [retainedMtfQuotesByTab]);

  useEffect(() => {
    watchlistTabRef.current = watchlistTab;
  }, [watchlistTab]);

  useEffect(() => {
    watchlistsRef.current = watchlists;
  }, [watchlists]);

  useEffect(() => {
    const validIds = new Set(watchlists.map((watchlist) => watchlist.id));
    setScannerWatchlistIds((current) => {
      const next = current.filter((id) => validIds.has(id));
      return next.length === current.length ? current : next;
    });
  }, [watchlists]);

  useEffect(() => {
    saveScannerWatchlistIds(scannerWatchlistIds);
  }, [scannerWatchlistIds]);

  useEffect(() => {
    if (!accountsConfirmedRef.current || !notificationState.appEnabled) return;
    syncNotificationPreferences(strategyState).catch(() => {});
  }, [notificationState.appEnabled, strategyState]);

  useEffect(() => {
    if (accountsConfirmedRef.current && activePage === "trades") refreshAutoTrades();
  }, [activePage, tradingAccountId]);

  return (
    <>
      <Header
        status={status}
        accounts={accounts}
        accountCount={accountCount}
        accountsConfirmedAt={accountsConfirmedAt}
        accountsLoading={loading.shell}
        accountsConfirmed={accountsConfirmedRef.current}
        selectedAccountId={selectedAccountId}
        pageLoading={pageLoading}
        onSelectAccount={(accountId) => setSelectedAccountId(preferredAccountId(accounts, accountId))}
        onRefreshAccounts={confirmAccountsAndStart}
        notificationState={notificationState}
        onEnableNotifications={enableAppNotifications}
        onDisableNotifications={disableAppNotifications}
        onRetryNotificationCheck={retryNotificationCheck}
        notifications={bellNotifications}
        onMarkNotificationsRead={markNotificationsRead}
        activePage={activePage}
        onNavigate={navigatePage}
        alertLogCount={alertLog.length}
        settingsBadge={autoTrade.enabled ? "Auto" : enabledStrategyCount}
        settingsControls={(
          <SettingsMenu
            accountId={tradingAccountId}
            autoTrade={autoTrade}
            autoLongEnabledCount={autoLongEnabledCount}
            disabled={loading.prices}
            enabledStrategyCount={enabledStrategyCount}
            onApplyRisk={refreshAllPrices}
            onAutoTradeChange={updateAutoTradeSettings}
            onRiskChange={updateRiskSettings}
            onToggleStrategy={toggleStrategy}
            riskSettings={riskSettings}
            strategyState={strategyState}
          />
        )}
      />
      {pageLoading ? (
        <div className="loading-blocker" aria-live="polite" aria-busy="true">
          <div className="page-loader">
            <span className="loading-spinner" aria-hidden="true"></span>
            <strong>Loading</strong>
          </div>
        </div>
      ) : null}
      <main className="shell">
        {alert ? <div className={`alert app-alert ${alertKind}`}>{alert}</div> : null}

        {activePage === "alerts" ? (
          <AlertLogPage
            alertLog={alertLog}
            onClear={clearAlertLog}
            onSelectSymbol={(symbol) => {
              focusMtfSymbol(symbol);
              navigatePage("mtfs");
            }}
          />
        ) : activePage === "mtfs" ? (
          <MtfPage
            buyState={buyState}
            focusedSymbol={focusedMtfSymbol}
            longMtfs={longMtfs}
            onBuy={buyMtfQuote}
            onDismissNew={(quote) => dismissNewMtfRow(quote.watchlist_id, quote.symbol)}
            shortMtfs={shortMtfs}
          />
        ) : activePage === "trades" ? (
          <AutoTradesPage
            accountId={tradingAccountId}
            alert={autoTradeAlert}
            loading={loading.trades}
            orders={autoTradeOrders}
            onRefresh={refreshAutoTrades}
          />
        ) : (
          <div className="market-command-center">
            <section className="premarket-focus-panel">
              <div className="scanner-hero">
                <div>
                  <h2>Premarket Scanner</h2>
                </div>
                <div className="live-price-actions">
                  <button type="button" onClick={() => refreshScannerPrices()} disabled={loading.prices}>
                    {loading.prices ? "Updating" : "Update"}
                  </button>
                </div>
              </div>

              <ScannerWatchlistPicker
                loading={loading.prices}
                onSelectAll={selectAllScannerWatchlists}
                onToggle={toggleScannerWatchlist}
                onUpdate={refreshScannerWatchlist}
                selectedIds={scannerWatchlistIds}
                watchlists={watchlists}
              />

              <div className="scanner-metric-grid" aria-label="Premarket scanner summary">
                <ScannerMetric label="Total" value={preMarketScannerRows.length} tone="neutral" />
                <ScannerMetric label="Long" value={scannerLongCount} tone="long" />
                <ScannerMetric label="Short" value={scannerShortCount} tone="short" />
              </div>

              {liveAlert ? <div className="alert">{liveAlert}</div> : null}
              <PreMarketScannerTable rows={preMarketScannerRows} />
            </section>

            <aside className="watchlist-control-rail">
              <WatchlistTabs
                activeTab={watchlistTab}
                onAddSymbols={addSymbolsToActiveWatchlist}
                onAddTab={addWatchlist}
                onDeleteTab={deleteWatchlist}
                loading={loading.watchlists || loading.prices}
                onSymbolInput={(value) => setSymbolInputs((current) => ({ ...current, [watchlistTab]: value }))}
                onSwitchTab={switchWatchlistTab}
                onToggleAutoTrade={toggleWatchlistAutoTrade}
                selectedWatchlist={contextWatchlist}
                symbolInput={symbolInputs[watchlistTab] || ""}
                watchlists={watchlists}
              />
            </aside>

            <section className="intraday-context-panel">
              <div className="section-heading">
                <div>
                  <h2>{contextWatchlist?.name || "Watchlist"}</h2>
                </div>
              </div>
              <div className="active-watchlist-tables">
                <div className="trend-price-grid">
                  <PriceBucket title="Bullish" quotes={trendBuckets.bullish} kind="bullish" onRemoveSymbol={(symbol) => removeSymbolFromWatchlist(symbol, contextWatchlist?.id)} />
                  <PriceBucket title="Bearish" quotes={trendBuckets.bearish} kind="bearish" onRemoveSymbol={(symbol) => removeSymbolFromWatchlist(symbol, contextWatchlist?.id)} />
                  <PriceBucket title="Chop" quotes={trendBuckets.chop} kind="chop" onRemoveSymbol={(symbol) => removeSymbolFromWatchlist(symbol, contextWatchlist?.id)} />
                </div>
                <p className="muted">{updatedText}</p>
              </div>
            </section>
          </div>
        )}
        <HiddenLegacyPanels />
      </main>
    </>
  );
}

function MtfPage({
  buyState,
  focusedSymbol,
  longMtfs,
  onBuy,
  onDismissNew,
  shortMtfs,
}) {
  const [tableView, setTableView] = useState("long");
  const tableViews = [
    { id: "long", label: "Long signals", direction: "Long", count: longMtfs.length },
    { id: "short", label: "Short signals", direction: "Short", count: shortMtfs.length },
  ];
  const selectedQuotes = tableView === "short" ? shortMtfs : longMtfs;
  const selectedView = tableViews.find((item) => item.id === tableView) || tableViews[0];
  const totalCount = longMtfs.length + shortMtfs.length;

  useEffect(() => {
    if (!focusedSymbol) return;
    const symbol = focusedSymbol.toUpperCase();
    if (shortMtfs.some((quote) => quote.symbol === symbol)) {
      setTableView("short");
    } else if (longMtfs.some((quote) => quote.symbol === symbol)) {
      setTableView("long");
    }
  }, [focusedSymbol, longMtfs, shortMtfs]);

  return (
    <section className="mtf-page global-mtf-panel">
      <div className="mtf-page-header">
        <div>
          <h2>MTF Signals</h2>
          <p className="muted">Long and short signals from every watchlist.</p>
        </div>
        <strong>{totalCount}</strong>
      </div>

      <div className="table-view-tabs mtf-view-tabs" role="tablist" aria-label="MTF table view">
        {tableViews.map((view) => (
          <button
            key={view.id}
            type="button"
            className={tableView === view.id ? "active" : ""}
            onClick={() => setTableView(view.id)}
            role="tab"
            aria-selected={tableView === view.id}
          >
            {view.label} <span>{view.count}</span>
          </button>
        ))}
      </div>
      <MtfSignalGroup
        buyState={buyState}
        focusedSymbol={focusedSymbol}
        direction={selectedView.direction}
        label={selectedView.label}
        onBuy={onBuy}
        onDismissNew={onDismissNew}
        quotes={selectedQuotes}
      />
    </section>
  );
}

function MtfSignalGroup({
  buyState,
  direction,
  focusedSymbol,
  label,
  onBuy,
  onDismissNew,
  quotes,
}) {
  const strategySections = mtfStrategySections(quotes);

  return (
    <section className="mtf-signal-group">
      <div className="mtf-signal-heading">
        <h3>{label}</h3>
        <span>{quotes.length}</span>
      </div>
      <div className="mtf-strategy-sections">
        {strategySections.length ? strategySections.map((section) => (
          <MtfTable
            key={section.id}
            quotes={section.quotes}
            title={section.name}
            subtitle={`${direction} setup`}
            showWatchlist
            buyState={buyState}
            emptyText="None"
            focusedSymbol={focusedSymbol}
            onBuy={onBuy}
            onDismissNew={onDismissNew}
          />
        )) : (
          <div className="mtf-empty-state">No {label.toLowerCase()} MTFs right now.</div>
        )}
      </div>
    </section>
  );
}

function mtfStrategySections(quotes) {
  return ALERT_STRATEGIES.map((strategy) => {
    const strategyQuotes = quotes
      .map((quote) => ({
        ...quote,
        mtf_matches: (quote.mtf_matches || []).filter((match) => strategy.match(match)),
      }))
      .filter((quote) => quote.mtf_matches.length);
    return { id: strategy.id, name: strategy.name, quotes: strategyQuotes };
  }).filter((section) => section.quotes.length);
}

function AutoTradesPage({ accountId, alert, loading, orders, onRefresh }) {
  const [tableView, setTableView] = useState("all");
  const buckets = orders?.buckets || emptyAutoTradeOrders().buckets;
  const counts = orders?.counts || emptyAutoTradeOrders().counts;
  const allOrders = orders?.orders || [];
  const tableViews = [
    { id: "all", label: "All", count: allOrders.length },
    { id: "buy", label: "Buy", count: counts.buy || 0 },
    { id: "sell", label: "Sell", count: counts.sell || 0 },
    { id: "open", label: "Open", count: counts.open || 0 },
    { id: "filled", label: "Filled", count: counts.filled || 0 },
  ];
  const visibleOrders = tableView === "all" ? allOrders : (buckets[tableView] || []);
  const activeTable = tableViews.find((item) => item.id === tableView) || tableViews[0];
  const tradeDate = orders?.trade_date;
  const historyTradeDate = orders?.history_trade_date;
  const dateText = accountId
    ? historyTradeDate && tradeDate && historyTradeDate !== tradeDate
      ? `Latest Webull history session ${historyTradeDate}, plus today's open orders for ${accountId}`
      : `Today's Webull orders for ${accountId}`
    : "Select a margin account to view broker orders.";
  return (
    <section className="auto-trades-page">
      <div className="auto-trades-header">
        <div>
          <h2>Auto Trades</h2>
          <p className="muted">{dateText}</p>
        </div>
        <button type="button" className="secondary-button" onClick={() => onRefresh()} disabled={loading || !accountId}>
          {loading ? "Refreshing" : "Refresh"}
        </button>
      </div>
      {alert ? <div className="alert">{alert}</div> : null}
      <div className="auto-trade-summary-grid" aria-label="Auto trade order counts">
        <SummaryTile label="Buy Orders" value={counts.buy || 0} />
        <SummaryTile label="Sell Orders" value={counts.sell || 0} />
        <SummaryTile label="Open Orders" value={counts.open || 0} />
        <SummaryTile label="Filled Orders" value={counts.filled || 0} />
      </div>
      <div className="table-view-tabs" role="tablist" aria-label="Trade table view">
        {tableViews.map((item) => (
          <button
            key={item.id}
            type="button"
            className={tableView === item.id ? "active" : ""}
            onClick={() => setTableView(item.id)}
            role="tab"
            aria-selected={tableView === item.id}
          >
            {item.label} <span>{item.count}</span>
          </button>
        ))}
      </div>
      <OrderBucket title={activeTable.label} items={visibleOrders} />
    </section>
  );
}

function SummaryTile({ label, value }) {
  return (
    <article className="auto-trade-summary-tile">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function OrderBucket({ title, items }) {
  return (
    <section className="auto-trade-bucket">
      <div className="auto-trade-bucket-heading">
        <h3>{title}</h3>
        <span>{items.length}</span>
      </div>
      <div className="auto-trade-table-wrap">
        <table className="auto-trade-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Side</th>
              <th>Status</th>
              <th>Qty</th>
              <th>Order</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {items.length ? items.map((item, index) => (
              <tr key={orderRowKey(item, index)}>
                <td data-label="Symbol"><strong>{item.symbol || "-"}</strong></td>
                <td data-label="Side"><span className={`order-side-pill ${orderSideClass(item.side)}`}>{item.side || "-"}</span></td>
                <td data-label="Status"><span className={`order-status-pill ${orderStatusClass(item.status)}`}>{item.status || "-"}</span></td>
                <td data-label="Qty">{orderQuantityText(item)}</td>
                <td data-label="Order">
                  <div className="auto-trade-order-detail">
                    <strong>{item.order_type || "-"}</strong>
                    <span>{orderPriceText(item)}</span>
                    <small>{item.client_order_id || item.order_id || "-"}</small>
                  </div>
                </td>
                <td data-label="Time">{orderTimeText(item)}</td>
              </tr>
            )) : (
              <tr>
                <td colSpan="6" className="alert-log-empty-cell">No {title.toLowerCase()} orders found</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function orderRowKey(item, index) {
  return item.client_order_id || item.order_id || `${item.symbol || "order"}-${item.side || ""}-${item.status || ""}-${index}`;
}

function orderSideClass(side) {
  const normalized = String(side || "").toLowerCase();
  if (normalized === "buy") return "buy";
  if (normalized === "sell") return "sell";
  return "unknown";
}

function orderStatusClass(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "filled") return "filled";
  if (normalized.includes("submit") || normalized.includes("open") || normalized.includes("partial") || normalized.includes("working")) return "open";
  if (normalized.includes("cancel") || normalized.includes("fail") || normalized.includes("reject")) return "error";
  return "unknown";
}

function orderQuantityText(item) {
  const quantity = item.quantity ?? "-";
  const filled = item.filled_quantity;
  return filled != null ? `${filled}/${quantity}` : String(quantity);
}

function orderPriceText(item) {
  const parts = [];
  if (item.avg_price != null) parts.push(`Avg ${formatPrice(item.avg_price)}`);
  if (item.limit_price != null) parts.push(`Limit ${formatPrice(item.limit_price)}`);
  if (item.stop_price != null) parts.push(`Stop ${formatPrice(item.stop_price)}`);
  return parts.length ? parts.join(" · ") : "-";
}

function orderTimeText(item) {
  const value = item.updated_at || item.created_at;
  return value ? formatDateTime(value) : "-";
}

function AlertLogPage({ alertLog, onClear, onSelectSymbol }) {
  const [query, setQuery] = useState("");
  const searched = useMemo(() => {
    const needle = query.trim().toUpperCase();
    if (!needle) return alertLog;
    return alertLog.filter((item) => (
      String(item.symbol || "").toUpperCase().includes(needle)
      || String(item.reason || item.title || "").toUpperCase().includes(needle)
      || String(item.body || "").toUpperCase().includes(needle)
      || String(item.kind || "").toUpperCase().includes(needle)
    ));
  }, [alertLog, query]);

  return (
    <section className="alert-log-page">
      <div className="alert-log-header">
        <div>
          <h2>Alerts</h2>
          <p className="muted">Synced history of notifications that actually fired.</p>
        </div>
        <button type="button" className="secondary-button" onClick={onClear} disabled={!alertLog.length}>Clear</button>
      </div>
      <div className="alert-log-search">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search ticker or setup"
          aria-label="Search alert log"
        />
        <strong>{searched.length}</strong>
      </div>
      <AlertLogTable
        items={searched}
        onSelectSymbol={onSelectSymbol}
      />
    </section>
  );
}

function AlertLogTable({ items, onSelectSymbol }) {
  return (
    <section className="alert-log-table-card history">
      <div className="alert-log-table-heading">
        <h3>Notification History</h3>
        <span>{items.length}</span>
        <em>Synced</em>
      </div>
      <div className="alert-log-table-wrap">
        <table className="alert-log-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Type</th>
              <th>Notification</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {items.length ? items.map((item) => (
              <tr key={item.id}>
                <td data-label="Symbol">
                  {item.symbol ? (
                    <button type="button" onClick={() => onSelectSymbol(item.symbol)}>{item.symbol}</button>
                  ) : "-"}
                </td>
                <td data-label="Type">{item.kind || "notification"}</td>
                <td data-label="Notification">
                  <div className="alert-log-alert">
                    <strong>{item.title || item.reason || "-"}</strong>
                    <span>{item.body || item.reason || "-"}</span>
                  </div>
                </td>
                <td data-label="Time">
                  <div className="alert-log-time">
                    <time dateTime={item.alertedAt || item.createdAt}>{formatDateTime(item.alertedAt || item.createdAt)}</time>
                    {item.source ? <small>{item.source}</small> : null}
                  </div>
                </td>
              </tr>
            )) : (
              <tr>
                <td colSpan="4" className="alert-log-empty-cell">No notifications saved yet</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RiskSettingsPanel({ disabled, riskSettings, onApply, onChange }) {
  function update(key, value) {
    onChange({ ...riskSettings, [key]: value });
  }

  return (
    <section className="risk-settings-panel" aria-label="A++ risk settings">
      <div className="risk-field">
        <span>Max risk</span>
        <label>
          <b>$</b>
          <input
            type="number"
            min="1"
            max="10000"
            step="1"
            value={riskSettings.riskAmount}
            disabled={disabled}
            onChange={(event) => update("riskAmount", event.target.value)}
          />
        </label>
      </div>
      <div className="risk-field">
        <span>SL mode</span>
        <select
          value={riskSettings.stopMode}
          disabled={disabled}
          onChange={(event) => update("stopMode", event.target.value)}
        >
          <option value="auto">Auto range</option>
          <option value="fixed">Fixed $</option>
        </select>
      </div>
      {riskSettings.stopMode === "fixed" ? (
        <div className="risk-field">
          <span>Cloud buffer</span>
          <label>
            <b>$</b>
            <input
              type="number"
              min="0.05"
              max="25"
              step="0.05"
              value={riskSettings.fixedStopBuffer}
              disabled={disabled}
              onChange={(event) => update("fixedStopBuffer", event.target.value)}
            />
          </label>
        </div>
      ) : (
        <div className="risk-field auto-risk-note">
          <span>Range</span>
          <strong>Last 3D</strong>
        </div>
      )}
      <button type="button" className="risk-apply-button" disabled={disabled} onClick={onApply}>
        Apply
      </button>
    </section>
  );
}

function SettingsMenu({
  accountId,
  autoTrade,
  autoLongEnabledCount,
  disabled,
  enabledStrategyCount,
  onApplyRisk,
  onAutoTradeChange,
  onRiskChange,
  onToggleStrategy,
  riskSettings,
  strategyState,
}) {
  return (
    <div className="settings-menu-content">
      <div className="settings-menu-heading">
        <div>
          <h2>Settings</h2>
          <p className="muted">
            {enabledStrategyCount} alert strategies active · {autoTrade.enabled ? "Auto Long on" : "Auto Long off"} · {autoLongEnabledCount} auto strategies
          </p>
        </div>
      </div>
      <RiskSettingsPanel
        disabled={disabled}
        onApply={onApplyRisk}
        onChange={onRiskChange}
        riskSettings={riskSettings}
      />
      <AutoTradePanel
        accountId={accountId}
        autoTrade={autoTrade}
        disabled={disabled}
        onChange={onAutoTradeChange}
      />
      <AlertStrategies strategyState={strategyState} onToggleStrategy={onToggleStrategy} />
    </div>
  );
}

function AutoTradePanel({ accountId, autoTrade, disabled, onChange }) {
  function toggleStrategy(strategyId) {
    onChange({
      ...autoTrade,
      strategies: {
        ...(autoTrade.strategies || {}),
        [strategyId]: autoTrade.strategies?.[strategyId] !== true,
      },
    });
  }

  const autoTradeStrategies = ALERT_STRATEGIES.filter((strategy) => !strategy.scannerOnly);
  const enabledCount = autoTradeStrategies.filter((strategy) => autoTrade.strategies?.[strategy.id]).length;

  return (
    <section className={`auto-trade-panel ${autoTrade.enabled ? "enabled" : ""}`} aria-label="Auto long trading">
      <div className="auto-trade-topline">
        <label className="auto-trade-toggle">
          <input
            type="checkbox"
            checked={autoTrade.enabled}
            disabled={disabled || !accountId}
            onChange={(event) => onChange({ ...autoTrade, enabled: event.target.checked })}
          />
          <span>
            <strong>Auto Long</strong>
            <small>Buys calculated size on selected long strategies with linked 1:1 target and SL exits.</small>
          </span>
        </label>
        <em>{accountId ? `${enabledCount} strategy${enabledCount === 1 ? "" : "ies"}` : "Select account"}</em>
      </div>
      <div className="auto-strategy-grid">
        {autoTradeStrategies.map((strategy) => (
          <label key={strategy.id} className={`auto-strategy-chip ${autoTrade.strategies?.[strategy.id] ? "enabled" : ""}`}>
            <input
              type="checkbox"
              checked={autoTrade.strategies?.[strategy.id] === true}
              disabled={disabled || !accountId}
              onChange={() => toggleStrategy(strategy.id)}
            />
            <span>{strategy.name}</span>
          </label>
        ))}
      </div>
    </section>
  );
}

function ScannerWatchlistPicker({ loading, onSelectAll, onToggle, onUpdate, selectedIds, watchlists }) {
  const selected = new Set(selectedIds);
  const allSelected = watchlists.length > 0 && selectedIds.length === watchlists.length;
  return (
    <div className="scanner-watchlist-picker" aria-label="Scanner watchlists">
      <button
        type="button"
        className={`scanner-watchlist-chip ${allSelected ? "active" : ""}`}
        onClick={onSelectAll}
      >
        All
      </button>
      {watchlists.map((watchlist) => (
        <span key={watchlist.id} className={`scanner-watchlist-item ${selected.has(watchlist.id) ? "active" : ""}`}>
          <button
            type="button"
            className="scanner-watchlist-chip"
            onClick={() => onToggle(watchlist.id)}
            aria-pressed={selected.has(watchlist.id)}
          >
            <span>{watchlist.name}</span>
            <b>{watchlist.symbols.length}</b>
          </button>
          <button
            type="button"
            className="scanner-watchlist-update"
            disabled={loading}
            onClick={() => onUpdate(watchlist.id)}
            aria-label={`Update ${watchlist.name}`}
            title={`Update ${watchlist.name}`}
          >
            Update
          </button>
        </span>
      ))}
    </div>
  );
}

function ScannerMetric({ label, value, tone }) {
  return (
    <article className={`scanner-metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function WatchlistTabs({
  activeTab,
  onAddSymbols,
  onAddTab,
  onDeleteTab,
  loading,
  onSwitchTab,
  onSymbolInput,
  onToggleAutoTrade,
  selectedWatchlist,
  symbolInput,
  watchlists,
}) {
  return (
    <section className="watchlist-panel" aria-label="Watchlists">
      <div className="watchlist-tabs" role="tablist" aria-label="Watchlist tabs">
        {watchlists.map((watchlist) => (
          <span key={watchlist.id} className={`watchlist-tab ${activeTab === watchlist.id ? "active" : ""}`}>
            <button
              type="button"
              onClick={() => onSwitchTab(watchlist.id)}
              role="tab"
              aria-selected={activeTab === watchlist.id}
            >
              {watchlist.name}
              <b>{watchlist.symbols.length}</b>
            </button>
            {!watchlist.locked ? (
              <button
                type="button"
                className="watchlist-delete"
                onClick={() => onDeleteTab(watchlist.id)}
                aria-label={`Delete ${watchlist.name}`}
              >
                x
              </button>
            ) : null}
          </span>
        ))}
        <button
          type="button"
          className="watchlist-add-tab"
          onClick={onAddTab}
          aria-label="Add watchlist tab"
          title="Add watchlist tab"
        >
          +
        </button>
      </div>
      <div className="daily-list-editor">
        <label className="watchlist-auto-trade-toggle">
          <input
            type="checkbox"
            checked={selectedWatchlist?.autoTradeEnabled !== false}
            disabled={!selectedWatchlist || loading}
            onChange={(event) => onToggleAutoTrade(selectedWatchlist.id, event.target.checked)}
          />
          <span>{selectedWatchlist?.autoTradeEnabled === false ? "Auto trade this list off" : "Auto trade this list on"}</span>
        </label>
        <form onSubmit={onAddSymbols}>
          <input
            aria-label={`Add symbols to ${selectedWatchlist?.name || "watchlist"}`}
            placeholder="Add ticker"
            value={symbolInput}
            onChange={(event) => onSymbolInput(event.target.value)}
          />
          <button type="submit" disabled={loading}>Add</button>
        </form>
      </div>
    </section>
  );
}
