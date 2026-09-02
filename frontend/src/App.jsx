import { useEffect, useMemo, useRef, useState } from "react";

import { AlertStrategies } from "./components/AlertStrategies";
import { Header } from "./components/Header";
import { HiddenLegacyPanels } from "./components/HiddenLegacyPanels";
import { InsiderBuyingPage } from "./components/InsiderBuying";
import { MtfTable, PreMarketScannerTable, PriceBucket, SpyComparisonTable } from "./components/PriceTables";
import { deleteJson, getJson, postJson } from "./lib/api";
import { ALERT_STRATEGIES, MTF_ALERT_STRATEGIES, filterMtfTableQuotes, loadStrategyState, saveStrategyState, strategyIdForMatch } from "./lib/alertStrategies";
import { cloudStatus, confirmedMtfQuotes, displayMtfLabel, flattenAccounts, formatPrice, isMarketRefreshWindow, marginTradingAccountId, matchEntryPrice, notificationMatchText, mtfSignature, preferredAccountId } from "./lib/market";
import { disableNotifications, enableNotifications, loadNotificationState, setAppBadgeCount, showDeviceNotification, syncNotificationPreferences } from "./lib/notifications";

const PASSIVE_MARKET_REFRESH_INTERVAL_MS = 60 * 1000;
const INSIDER_REFRESH_INTERVAL_MS = 2 * 60 * 1000;
const MAX_NOTIFICATIONS = 20;
const MAX_ALERT_LOG = 500;
const DAILY_SYMBOLS_KEY = "dhanam-daily-symbols";
const WATCHLISTS_KEY = "dhanam-watchlists";
const SCANNER_WATCHLISTS_KEY = "dhanam-scanner-watchlists";
const VISIBLE_TABS_KEY = "dhanam-visible-tabs";
const RISK_SETTINGS_KEY = "dhanam-risk-settings";
const ALERT_LOG_KEY = "dhanam-alert-log";
const RETAINED_MTF_QUOTES_KEY = "dhanam-retained-mtf-quotes";
const AUTO_TRADE_KEY = "dhanam-auto-trade";
const AUTO_TRADE_EXECUTIONS_KEY = "dhanam-auto-trade-executions";
const BOS_STATE_KEY = "dhanam-bos-state";
const INSIDER_SEEN_KEY = "dhanam-insider-seen-records";
const INSIDER_BASELINE_SENTINEL = "__INSIDER_BASELINE__";
const MAX_AUTO_TRADE_EXECUTIONS = 500;
const MAX_INSIDER_SEEN_RECORDS = 1000;
const WATCHLIST_REFRESH_CONCURRENCY = 1;
const MAX_WATCHLIST_SYMBOLS = 25;
const ALL_WATCHLISTS_TAB_ID = "__all-watchlists";
const OG_WATCHLIST_ID = "og";
const SPY_SYMBOL = "SPY";
const TRADINGVIEW_WIDGET_URL = "https://www.tradingview-widget.com/embed-widget/advanced-chart/";
const CHART_GROUP_COLORS = ["#f59e0b", "#38bdf8", "#22c55e", "#f43f5e", "#a78bfa", "#14b8a6"];
const OG_SYMBOLS = [
  "BE", "CRDO", "AAOI", "SNDK", "MU", "GLW", "MRVL", "COHR", "RKLB",
  "ASTS", "AMD", "ARM", "AVGO", "DELL", "INTC", "APP", "LLY",
  "APLD", "CIFR", "CRWV", "HUT", "IREN", "NBIS", "WULF",
];
const SECTOR_SYMBOLS = ["SOXL", "XLV", "CIBR", "XLF", "XLK"];
const APP_TABS = [
  { id: "mtfs", label: "MTFs", data: "watchlists" },
  { id: "watchlist", label: "Watchlist", data: "watchlists" },
  { id: "sectors", label: "Sectors", data: "sectors" },
  { id: "insiders", label: "Insiders", data: "insiders" },
  { id: "alerts", label: "Alerts", data: "alerts" },
  { id: "charts", label: "Charts", data: "watchlists" },
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

function loadVisibleTabs() {
  try {
    return normalizeVisibleTabs(JSON.parse(window.localStorage.getItem(VISIBLE_TABS_KEY) || "{}"));
  } catch {
    return normalizeVisibleTabs({});
  }
}

function saveVisibleTabs(tabs) {
  window.localStorage.setItem(VISIBLE_TABS_KEY, JSON.stringify(normalizeVisibleTabs(tabs)));
}

function normalizeVisibleTabs(tabs) {
  const hasSavedChoice = tabs && APP_TABS.some((tab) => Object.prototype.hasOwnProperty.call(tabs, tab.id));
  const normalized = Object.fromEntries(APP_TABS.map((tab) => [
    tab.id,
    hasSavedChoice ? tabs?.[tab.id] !== false : tab.id === "watchlist",
  ]));
  if (!APP_TABS.some((tab) => normalized[tab.id])) normalized.watchlist = true;
  return normalized;
}

function firstVisibleTab(tabs) {
  return APP_TABS.find((tab) => tabs?.[tab.id] !== false)?.id || "watchlist";
}

function routePageFromHash(tabs = loadVisibleTabs()) {
  const hashPage = window.location.hash.replace(/^#/, "");
  const page = hashPage === "home" || hashPage === "spy" ? "mtfs" : hashPage;
  if (APP_TABS.some((tab) => tab.id === page) && tabs[page] !== false) return page;
  return firstVisibleTab(tabs);
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
      symbols: normalizeSymbols(item?.symbols || []).slice(0, MAX_WATCHLIST_SYMBOLS),
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

function uniqueSortedSymbolsFromWatchlists(watchlists) {
  const symbols = new Set();
  watchlists.forEach((watchlist) => {
    (watchlist.symbols || []).forEach((symbol) => {
      const normalized = String(symbol || "").trim().toUpperCase();
      if (normalized) symbols.add(normalized);
    });
  });
  return [...symbols].sort(compareSymbols);
}

function uniqueSortedQuotesFromWatchlists(watchlists, quotesByTab) {
  const quotesBySymbol = new Map();
  watchlists.forEach((watchlist) => {
    (quotesByTab[watchlist.id] || []).forEach((quote) => {
      const symbol = String(quote.symbol || "").trim().toUpperCase();
      if (symbol && !quotesBySymbol.has(symbol)) {
        quotesBySymbol.set(symbol, { ...quote, symbol });
      }
    });
  });
  return [...quotesBySymbol.values()].sort((left, right) => compareSymbols(left.symbol, right.symbol));
}

function compareSymbols(left, right) {
  return String(left || "").localeCompare(String(right || ""), undefined, { numeric: true, sensitivity: "base" });
}

function clearTenMinuteEmaTrend(quote) {
  return cloudStatus(quote.ema_10m, ["5", "12"], ["34", "50"]);
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

function bosStatus(quote) {
  return String(quote?.structure_10m?.status || "Unknown");
}

function isMonitorableBosStatus(status) {
  return ["Bullish BOS", "Bearish BOS", "Chop"].includes(String(status || ""));
}

function bosNotificationDetails(changes) {
  const targetSymbol = changes[0]?.symbol || "";
  if (changes.length === 1) {
    const change = changes[0];
    return {
      title: `${change.symbol}: ${appStructureLabel(change.nextStatus)}`,
      body: change.previousStatus
        ? `BOS changed from ${appStructureLabel(change.previousStatus)} to ${appStructureLabel(change.nextStatus)}.`
        : `BOS is now ${appStructureLabel(change.nextStatus)}.`,
      badgeCount: 1,
      tag: `bos-${change.symbol}`,
      targetSymbol,
      url: "/#alerts",
    };
  }
  const preview = changes.slice(0, 3).map((change) => `${change.symbol} ${appStructureLabel(change.nextStatus)}`).join(" | ");
  return {
    title: `${changes.length} BOS changes`,
    body: changes.length > 3 ? `${preview}...` : preview,
    badgeCount: changes.length,
    tag: "bos-batch",
    targetSymbol,
    url: "/#alerts",
  };
}

function spyCurlNotificationDetails(position) {
  const setup = position.setup || "Curl Watch";
  const bias = position.bias || "Wait";
  const title = setup === "Curl Up"
    ? "SPY Curl Up: attack Strong list"
    : setup === "Break Curl Down"
      ? "SPY Break Curl Down: attack Weak list"
      : "SPY Curl Watch: 5/12 cloud";
  const body = setup === "Curl Up"
    ? "SPY is at the 5/12 cloud from below. Look for upside leaders."
    : setup === "Break Curl Down"
      ? "SPY is at the 5/12 cloud from above. Look for downside leaders."
      : "SPY is inside the 5/12 cloud. Watch for curl direction.";
  return {
    title,
    body,
    badgeCount: 1,
    tag: `spy-curl-${setup.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    targetSymbol: SPY_SYMBOL,
    url: "/#spy",
    setup,
    bias,
  };
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

function loadBosState() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(BOS_STATE_KEY) || "{}");
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  } catch {
    return {};
  }
}

function saveBosState(items) {
  window.localStorage.setItem(BOS_STATE_KEY, JSON.stringify(items || {}));
}

function loadInsiderSeenRecords() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(INSIDER_SEEN_KEY) || "[]");
    return Array.isArray(saved) ? saved.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function saveInsiderSeenRecords(keys) {
  const uniqueKeys = [...new Set((keys || []).map(String).filter(Boolean))].slice(0, MAX_INSIDER_SEEN_RECORDS);
  window.localStorage.setItem(INSIDER_SEEN_KEY, JSON.stringify(uniqueKeys));
  return uniqueKeys;
}

function insiderRecordKey(record) {
  if (record?.recordId) return String(record.recordId).trim().toUpperCase();
  return [
    record?.accessionNumber,
    record?.ticker,
    record?.transactionDate || record?.filingDate,
    record?.insider,
    record?.shares,
    Number(record?.price || 0).toFixed(4),
  ].map((value) => String(value || "").trim().toUpperCase()).join(":");
}

function insiderNotificationDetails(records) {
  const sortedRecords = [...records].sort((left, right) => Number(right.value || 0) - Number(left.value || 0));
  const topRecord = sortedRecords[0] || {};
  const symbols = [...new Set(sortedRecords.map((record) => String(record.ticker || "").toUpperCase()).filter(Boolean))];
  const symbolText = symbols.slice(0, 4).join(", ");
  const extraText = symbols.length > 4 ? ` +${symbols.length - 4}` : "";
  const count = sortedRecords.length;
  const title = count === 1
    ? `New insider buy: ${topRecord.ticker || "QQQ"}`
    : `${count} new insider buys`;
  const body = count === 1
    ? `${topRecord.insider || "An insider"} bought ${topRecord.ticker || "a Nasdaq-100 stock"} on ${topRecord.transactionDate || "the reported date"}; filed ${topRecord.filedAt || topRecord.filingDate || "now"}.`
    : `${symbolText}${extraText} have new SEC open-market purchase filings.`;
  return {
    kind: "insider",
    title,
    body,
    badgeCount: count,
    tag: "insider-buy-update",
    targetSymbol: topRecord.ticker || symbols[0] || "",
    url: "/#insiders",
  };
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
  return notificationContentKey(item);
}

function notificationContentKey(item) {
  const title = String(item?.title || item?.reason || "").trim().toUpperCase().replace(/\s+/g, " ");
  const body = String(item?.body || item?.message || item?.reason || "").trim().toUpperCase().replace(/\s+/g, " ");
  const symbol = String(item?.symbol || item?.targetSymbol || item?.target_symbol || "").trim().toUpperCase();
  return `${symbol}:${title}:${body}`;
}

function alertHistoryNotification(item) {
  return {
    id: `history-${notificationContentKey(item)}`,
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

function normalizeBellNotifications(items) {
  const byContent = new Map();
  for (const item of items || []) {
    const key = notificationContentKey(item);
    const current = byContent.get(key);
    if (!current || notificationTimestamp(item) > notificationTimestamp(current) || (!item.read && current.read)) {
      byContent.set(key, item);
    }
  }
  return [...byContent.values()]
    .sort((left, right) => notificationTimestamp(right) - notificationTimestamp(left))
    .slice(0, MAX_NOTIFICATIONS);
}

function notificationTimestamp(item) {
  const parsed = new Date(item?.createdAt || item?.alertedAt || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
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
        structure: quote.structure_10m?.status || "Unknown",
        cloudBias: quote.ema_10m_cloud?.bias || "",
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

function emaCloudRange(emaSet, fastKey = "5", slowKey = "12") {
  const fast = Number(emaSet?.[fastKey]);
  const slow = Number(emaSet?.[slowKey]);
  if (!Number.isFinite(fast) || !Number.isFinite(slow)) return null;
  return {
    fast,
    slow,
    low: Math.min(fast, slow),
    high: Math.max(fast, slow),
  };
}

function emaCloudPosition(quote) {
  const price = Number(quote?.scanner_price ?? quote?.price);
  const cloud = emaCloudRange(quote?.ema_10m);
  const cloudContext = quote?.ema_10m_cloud || {};
  if (!Number.isFinite(price) || !cloud) {
    return { price, cloud, status: "Unknown", distancePct: null, setup: "Unknown", bias: "Wait", previousStatus: "Unknown" };
  }
  if (price >= cloud.low && price <= cloud.high) {
    return {
      price,
      cloud,
      status: "Inside",
      distancePct: 0,
      setup: cloudContext.setup || "Curl Watch",
      bias: cloudContext.bias || "Wait",
      previousStatus: cloudContext.previous_status || "Unknown",
    };
  }
  const boundary = price > cloud.high ? cloud.high : cloud.low;
  const status = price > cloud.high ? "Above" : "Below";
  return {
    price,
    cloud,
    status,
    distancePct: boundary ? ((price - boundary) / boundary) * 100 : null,
    setup: cloudContext.setup || (status === "Above" ? "Above 5/12" : "Below 5/12"),
    bias: cloudContext.bias || (status === "Above" ? "Long" : "Short"),
    previousStatus: cloudContext.previous_status || "Unknown",
  };
}

function emaCloudTrendLabel(positionOrStatus) {
  const position = typeof positionOrStatus === "string" ? { status: positionOrStatus } : positionOrStatus || {};
  if (position.status === "Above") return "Bullish";
  if (position.status === "Below") return "Bearish";
  if (position.status === "Inside") return position.setup || "Curl Watch";
  return "-";
}

function spyCloudDisplay(position) {
  if (position?.status === "Inside") return position.setup || "Curl Zone";
  return position?.status || "-";
}

function isDirectionalBos(status) {
  return ["Bullish BOS", "Bearish BOS"].includes(String(status || ""));
}

function spyComparisonRowsFromWatchlists(watchlists, quotesByTab, spyQuote) {
  const spyPosition = emaCloudPosition(spyQuote);
  const spyTrend = emaCloudTrendLabel(spyPosition);
  const rowsBySymbol = new Map();
  for (const watchlist of watchlists) {
    for (const quote of quotesByTab[watchlist.id] || []) {
      const position = emaCloudPosition(quote);
      if (!position.cloud || !Number.isFinite(position.price)) continue;
      const structure = quote.structure_10m?.status || "Unknown";
      if (!isDirectionalBos(structure)) continue;
      const existing = rowsBySymbol.get(quote.symbol);
      const watchlistNames = existing
        ? [...existing.watchlistNames, watchlist.name]
        : [watchlist.name];
      rowsBySymbol.set(quote.symbol, {
        symbol: quote.symbol,
        watchlistName: watchlistNames.join(", "),
        watchlistNames,
        price: position.price,
        ema5: position.cloud.fast,
        ema12: position.cloud.slow,
        status: position.status,
        distancePct: position.distancePct,
        cloudSetup: position.setup,
        cloudBias: position.bias,
        structure,
        trend: cloudStatus(quote.ema_10m, ["5"], ["12"]),
        spyPrice: spyPosition.price,
        spyEma5: spyPosition.cloud?.fast ?? null,
        spyEma12: spyPosition.cloud?.slow ?? null,
        spyStatus: spyPosition.status,
        spyTrend,
      });
    }
  }
  return [...rowsBySymbol.values()].sort((left, right) => (
    spyStrengthRank(right.status) - spyStrengthRank(left.status)
    || Math.abs(Number(left.distancePct || 0)) - Math.abs(Number(right.distancePct || 0))
    || cloudTrendRank(left.trend) - cloudTrendRank(right.trend)
    || left.symbol.localeCompare(right.symbol)
  ));
}

function spyPlaybook(spyPositionOrStatus) {
  const spyPosition = typeof spyPositionOrStatus === "string" ? { status: spyPositionOrStatus } : spyPositionOrStatus || {};
  const spyStatus = spyPosition.status;
  if (spyStatus === "Above") {
    return {
      focusLabel: "Strong Stocks",
      focusStatus: "Above",
      focusId: "strong",
      tone: "strong",
      title: "SPY strong: work the Strong list",
      detail: "SPY is above its 5/12 cloud. Favor stocks above their own 5/12 cloud first.",
    };
  }
  if (spyStatus === "Below") {
    return {
      focusLabel: "Weak Stocks",
      focusStatus: "Below",
      focusId: "weak",
      tone: "weak",
      title: "SPY weak: work the Weak list",
      detail: "SPY is below its 5/12 cloud. Favor stocks below their own 5/12 cloud first.",
    };
  }
  if (spyStatus === "Inside") {
    if (spyPosition.bias === "Long") {
      return {
        focusLabel: "Strong Stocks",
        focusStatus: "Above",
        focusId: "strong",
        tone: "strong",
        title: "SPY at 5/12: high-value curl up",
        detail: "This is the curl zone from below. Attack the Strong list and look for upside leaders.",
      };
    }
    if (spyPosition.bias === "Short") {
      return {
        focusLabel: "Weak Stocks",
        focusStatus: "Below",
        focusId: "weak",
        tone: "weak",
        title: "SPY at 5/12: break curl down",
        detail: "This is the rejection zone from above. Attack the Weak list and look for downside leaders.",
      };
    }
    return {
      focusLabel: "Wait / At 5/12",
      focusStatus: "Inside",
      focusId: "wait",
      tone: "wait",
      title: "SPY at 5/12: curl zone",
      detail: "This is not weak. Watch for a curl up from below or a break curl down from above.",
    };
  }
  return {
    focusLabel: "-",
    focusStatus: "",
    focusId: "",
    tone: "unknown",
    title: "Waiting for SPY trend",
    detail: "Refresh SPY to decide whether to focus Strong or Weak.",
  };
}

function spyComparisonSections(rows, spyQuote) {
  const spyPosition = emaCloudPosition(spyQuote);
  const playbook = spyPlaybook(spyPosition);
  const sectionConfig = [
    {
      id: "strong",
      tone: "strong",
      focusStatus: "Above",
      action: "Long",
      title: "Focus: Long",
      subtitle: "Strong names closest to 5/12 first.",
    },
    {
      id: "weak",
      tone: "weak",
      focusStatus: "Below",
      action: "Short",
      title: "Focus: Short",
      subtitle: "Weak names closest to 5/12 first.",
    },
    {
      id: "wait",
      tone: "wait",
      focusStatus: "Inside",
      action: "Wait",
      title: "Curl Watch",
      subtitle: "Only clear long or short curl names.",
    },
  ];
  const activeSection = sectionConfig.find((section) => section.id === playbook.focusId)
    || sectionConfig.find((section) => section.focusStatus === playbook.focusStatus)
    || sectionConfig[2];
  return [{
    ...activeSection,
    badge: "Focus now",
    rows: rows
      .filter((row) => row.status === activeSection.focusStatus)
      .map((row) => ({ ...row, focusAction: spyRowAction(row) }))
      .filter((row) => row.focusAction === "Long" || row.focusAction === "Short")
      .sort((left, right) => (
        Math.abs(Number(left.distancePct || 0)) - Math.abs(Number(right.distancePct || 0))
        || left.symbol.localeCompare(right.symbol)
      )),
  }];
}

function spyRowAction(row) {
  const structure = String(row?.structure || "").toLowerCase();
  const cloudBias = String(row?.cloudBias || "").toLowerCase();
  if (row?.status === "Above" && structure.includes("bullish")) return "Long";
  if (row?.status === "Below" && structure.includes("bearish")) return "Short";
  if (row?.status === "Inside" && cloudBias === "long" && structure.includes("bullish")) return "Long";
  if (row?.status === "Inside" && cloudBias === "short" && structure.includes("bearish")) return "Short";
  return "Wait";
}

function SpyDecisionBanner({ playbook }) {
  return (
    <div className={`spy-decision-banner ${playbook.tone}`}>
      <strong>{playbook.title}</strong>
      <span>{playbook.detail}</span>
    </div>
  );
}

function spyStrengthRank(status) {
  if (status === "Above") return 2;
  if (status === "Inside") return 1;
  if (status === "Below") return 0;
  return -1;
}

function cloudTrendRank(trend) {
  if (trend === "Bullish") return 0;
  if (trend === "Bearish") return 1;
  if (trend === "Chop") return 2;
  return 3;
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
  const [spyQuote, setSpyQuote] = useState(null);
  const [spyUpdatedText, setSpyUpdatedText] = useState("SPY polling stopped");
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
    monitor: null,
  });
  const [notifications, setNotifications] = useState([]);
  const [alertLog, setAlertLog] = useState(loadAlertLog);
  const [retainedMtfQuotesByTab, setRetainedMtfQuotesByTab] = useState(loadRetainedMtfQuotes);
  const [visibleTabs, setVisibleTabs] = useState(loadVisibleTabs);
  const [activePage, setActivePage] = useState(() => routePageFromHash());
  const [autoTradeOrders, setAutoTradeOrders] = useState(() => emptyAutoTradeOrders());
  const [autoTradeAlert, setAutoTradeAlert] = useState("");
  const [strategyState, setStrategyState] = useState(loadStrategyState);
  const [riskSettings, setRiskSettings] = useState(loadRiskSettings);
  const [autoTrade, setAutoTrade] = useState(loadAutoTradeSettings);
  const [watchlistTab, setWatchlistTab] = useState(OG_WATCHLIST_ID);
  const [homeView, setHomeView] = useState("spy");
  const [sectorGroups, setSectorGroups] = useState([]);
  const [sectorUpdatedText, setSectorUpdatedText] = useState("Sector polling stopped");
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
  const insiderRefreshTimer = useRef(null);
  const initialMarketLoadStarted = useRef(false);
  const lastMtfSignature = useRef(initialTabState(loadWatchlists(), null));
  const lastMtfRows = useRef(initialTabState(loadWatchlists(), {}));
  const lastScannerRows = useRef(null);
  const lastBosRows = useRef(loadBosState());
  const lastSpyCurlSignature = useRef(null);
  const strategyStateRef = useRef(strategyState);
  const riskSettingsRef = useRef(riskSettings);
  const autoTradeRef = useRef(autoTrade);
  const autoTradeExecutionsRef = useRef(new Set(loadAutoTradeExecutions()));
  const alertLogRef = useRef(alertLog);
  const insiderSeenRecordsRef = useRef(loadInsiderSeenRecords());
  const selectedAccountIdRef = useRef(selectedAccountId);
  const accountsRef = useRef(accounts);
  const accountsConfirmedRef = useRef(false);
  const visibleTabsRef = useRef(visibleTabs);
  const watchlistTabRef = useRef(watchlistTab);
  const watchlistsRef = useRef(watchlists);
  const retainedMtfQuotesRef = useRef(retainedMtfQuotesByTab);
  const allWatchlistQuotes = useMemo(() => uniqueSortedQuotesFromWatchlists(watchlists, quotesByTab), [quotesByTab, watchlists]);
  const allWatchlistSymbols = useMemo(() => uniqueSortedSymbolsFromWatchlists(watchlists), [watchlists]);
  const allWatchlistSummary = `${allWatchlistQuotes.length} of ${allWatchlistSymbols.length} symbols loaded across ${watchlists.length} watchlists`;
  const isAllWatchlistsTab = watchlistTab === ALL_WATCHLISTS_TAB_ID;
  const activeWatchlist = isAllWatchlistsTab ? null : watchlists.find((item) => item.id === watchlistTab) || watchlists[0];
  const contextWatchlist = isAllWatchlistsTab
    ? { id: ALL_WATCHLISTS_TAB_ID, name: "All", symbols: allWatchlistSymbols, locked: true, derived: true }
    : activeWatchlist || watchlists[0];
  const quotes = isAllWatchlistsTab ? allWatchlistQuotes : (quotesByTab[contextWatchlist?.id] || []);
  const updatedText = isAllWatchlistsTab ? allWatchlistSummary : (updatedTextByTab[contextWatchlist?.id] || "");
  const pageLoading = loading.shell || loading.watchlists || loading.prices || loading.notifications || loading.trades;
  const tradingAccountId = useMemo(() => marginTradingAccountId(accounts, selectedAccountId), [accounts, selectedAccountId]);
  const trendBuckets = useMemo(() => {
    return quotes.reduce(
      (buckets, quote) => {
        const trend = clearTenMinuteEmaTrend(quote);
        if (trend === "Bullish") buckets.bullish.push(quote);
        else if (trend === "Bearish") buckets.bearish.push(quote);
        return buckets;
      },
      { bullish: [], bearish: [] },
    );
  }, [quotes]);
  const scannerWatchlists = useMemo(() => {
    const selectedIds = new Set(scannerWatchlistIds);
    return watchlists.filter((watchlist) => selectedIds.has(watchlist.id));
  }, [scannerWatchlistIds, watchlists]);
  const preMarketScannerRows = useMemo(() => preMarketScannerRowsFromWatchlists(scannerWatchlists, quotesByTab), [scannerWatchlists, quotesByTab]);
  const spyComparisonRows = useMemo(
    () => spyComparisonRowsFromWatchlists(watchlists, quotesByTab, spyQuote),
    [quotesByTab, spyQuote, watchlists],
  );
  const spyFocusStatus = spyPlaybook(emaCloudPosition(spyQuote)).focusStatus;
  const spyFocusCount = spyFocusStatus
    ? spyComparisonRows.filter((row) => row.status === spyFocusStatus).length
    : spyComparisonRows.length;
  const structureBySymbol = useMemo(() => {
    const structureMap = {};
    watchlists.forEach((watchlist) => {
      (quotesByTab[watchlist.id] || []).forEach((quote) => {
        const symbol = String(quote.symbol || "").toUpperCase();
        if (!symbol) return;
        const status = quote.structure_10m?.status || "Unknown";
        if (!structureMap[symbol] || structureMap[symbol] === "Unknown" || status !== "Unknown") {
          structureMap[symbol] = status;
        }
      });
    });
    const spySymbol = String(spyQuote?.symbol || "").toUpperCase();
    if (spySymbol) structureMap[spySymbol] = spyQuote?.structure_10m?.status || "Unknown";
    return structureMap;
  }, [quotesByTab, spyQuote, watchlists]);
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
    return filterMtfTableQuotes(matches);
  }, [newMtfRows, quotesByTab, watchlists]);
  const allMtfTouchQuotes = useMemo(() => {
    const touched = watchlists.flatMap((watchlist) => (
      (quotesByTab[watchlist.id] || [])
        .filter((quote) => quote.mtf_touches_today?.length)
        .map((quote) => ({
          ...quote,
          mtf_matches: quote.mtf_touches_today,
          watchlist_id: watchlist.id,
          watchlist_name: watchlist.name,
          is_new: Boolean(newMtfRows[mtfRowId(watchlist.id, quote.symbol)]),
        }))
    ));
    return filterMtfTableQuotes(touched);
  }, [newMtfRows, quotesByTab, watchlists]);
  const allMtfs = useMemo(() => quotesWithMatchStatus(allMtfQuotes, "confirmed"), [allMtfQuotes]);
  const allTouchedMtfs = useMemo(() => quotesWithMatchStatus(allMtfTouchQuotes, "confirmed"), [allMtfTouchQuotes]);
  const longMtfs = useMemo(() => quotesWithTradeAction(allMtfs, "Long"), [allMtfs]);
  const shortMtfs = useMemo(() => quotesWithTradeAction(allMtfs, "Short"), [allMtfs]);
  const enabledStrategyCount = useMemo(
    () => MTF_ALERT_STRATEGIES.length,
    [],
  );
  const autoLongEnabledCount = useMemo(
    () => ALERT_STRATEGIES.filter((strategy) => !strategy.scannerOnly && autoTrade.strategies?.[strategy.id]).length,
    [autoTrade.strategies],
  );
  const bellNotifications = useMemo(() => {
    const localItems = notifications.slice(0, MAX_NOTIFICATIONS);
    const historyItems = alertLog.slice(0, MAX_NOTIFICATIONS).map(alertHistoryNotification);
    return normalizeBellNotifications([...localItems, ...historyItems]);
  }, [alertLog, notifications]);
  const unreadNotificationCount = useMemo(() => bellNotifications.filter((item) => !item.read).length, [bellNotifications]);

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
    if (!isTabDataEnabled("watchlists")) return null;
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
    if (!isTabDataEnabled("alerts")) return;
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

  async function refreshAllPrices({ showLoading = true, force = false } = {}) {
    if (!accountsConfirmedRef.current) {
      setLiveAlert("Confirm Webull accounts before starting market data refresh.");
      return;
    }
    if (!isTabDataEnabled("watchlists")) return;
    setLiveAlert("");
    if (showLoading) setLoadingKey("prices", true);
    try {
      await refreshWatchlistBatch(watchlistsRef.current, { force: force || showLoading });
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
    if (!isTabDataEnabled("watchlists")) return;
    setLiveAlert("");
    if (showLoading) setLoadingKey("prices", true);
    try {
      const selectedIds = new Set(scannerWatchlistIds);
      const lists = watchlistsRef.current.filter((watchlist) => selectedIds.has(watchlist.id));
      if (!lists.length) {
        setLiveAlert("Select a list for the scanner.");
        return;
      }
      await refreshWatchlistBatch(lists, { force: showLoading });
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
    if (!isTabDataEnabled("watchlists")) return;
    const watchlist = watchlistsRef.current.find((item) => item.id === id);
    if (!watchlist) return;
    setLiveAlert("");
    setLoadingKey("prices", true);
    try {
      await refreshWatchlistPrices(watchlist, { force: true });
    } catch (error) {
      setLiveAlert(error.message);
    } finally {
      setLoadingKey("prices", false);
    }
  }

  async function refreshWatchlistBatch(lists, { force = false } = {}) {
    let index = 0;
    const errors = [];
    const workerCount = Math.min(WATCHLIST_REFRESH_CONCURRENCY, lists.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (index < lists.length) {
        const watchlist = lists[index];
        index += 1;
        try {
          await refreshWatchlistPrices(watchlist, { force });
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

  async function refreshWatchlistPrices(watchlist, { force = false } = {}) {
    if (!accountsConfirmedRef.current) return;
    if (!isTabDataEnabled("watchlists")) return;
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
    if (force) query.set("force", "true");
    const payload = await getJson(`/api/webull/live-prices?${query.toString()}`);
    if (!payload.ok) {
      const errorText = livePriceErrorText(payload);
      setUpdatedTextForTab(watchlist.id, errorText.status);
      setLiveAlert(errorText.alert);
      return;
    }
    const nextQuotes = payload.quotes || [];
    const currentMtfs = filterMtfTableQuotes(alertableMtfQuotes(nextQuotes));
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

  async function refreshSpyQuote({ force = false } = {}) {
    if (!accountsConfirmedRef.current) return;
    if (!isTabDataEnabled("watchlists")) return;
    const settings = riskSettingsRef.current;
    const query = new URLSearchParams({
      symbols: SPY_SYMBOL,
      risk_amount: String(settings.riskAmount),
      stop_mode: settings.stopMode,
      fixed_stop_buffer: String(settings.fixedStopBuffer),
    });
    if (force) query.set("force", "true");
    const payload = await getJson(`/api/webull/live-prices?${query.toString()}`);
    if (!payload.ok) {
      const errorText = livePriceErrorText(payload);
      setSpyUpdatedText(errorText.status);
      setLiveAlert(errorText.alert);
      return;
    }
    const [nextSpyQuote] = payload.quotes || [];
    setSpyQuote(nextSpyQuote || null);
    setSpyUpdatedText(`SPY updated ${new Date().toLocaleTimeString()} from ${payload.source || "webull"}`);
  }

  async function refreshSectorPrices({ force = false, showLoading = true } = {}) {
    if (!accountsConfirmedRef.current) return;
    if (!isTabDataEnabled("sectors")) return;
    if (showLoading) setLoadingKey("prices", true);
    const settings = riskSettingsRef.current;
    const query = new URLSearchParams({
      symbols: SECTOR_SYMBOLS.join(","),
      risk_amount: String(settings.riskAmount),
      stop_mode: settings.stopMode,
      fixed_stop_buffer: String(settings.fixedStopBuffer),
      limit: "4",
    });
    if (force) query.set("force", "true");
    try {
      const payload = await getJson(`/api/webull/sector-movers?${query.toString()}`);
      setSectorGroups(payload.groups || []);
      if (!payload.ok) {
        const errorText = livePriceErrorText(payload);
        setSectorUpdatedText(errorText.status);
        setLiveAlert(errorText.alert);
        return;
      }
      setSectorUpdatedText(`Updated ${new Date().toLocaleTimeString()} from ${payload.source || "webull"}`);
    } catch (error) {
      setSectorUpdatedText("Sector polling failed");
      setLiveAlert(error.message);
    } finally {
      if (showLoading) setLoadingKey("prices", false);
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

  function notifyBosUpdate(tab, watchlistName, nextQuotes) {
    const previousRows = lastBosRows.current || {};
    const nextRows = { ...previousRows };
    const changes = [];
    for (const quote of nextQuotes) {
      const symbol = String(quote.symbol || "").toUpperCase();
      const nextStatus = bosStatus(quote);
      if (!symbol || !isMonitorableBosStatus(nextStatus)) continue;
      const previous = previousRows[symbol];
      nextRows[symbol] = {
        status: nextStatus,
        structureTime: quote.structure_10m?.time || "",
        watchlistId: tab,
        watchlistName,
        updatedAt: new Date().toISOString(),
      };
      if (!previous || previous.status === nextStatus) continue;
      changes.push({
        symbol,
        previousStatus: previous.status,
        nextStatus,
        watchlistName,
        structureTime: quote.structure_10m?.time || "",
      });
    }
    lastBosRows.current = nextRows;
    saveBosState(nextRows);
    if (!changes.length) return;
    publishBosNotification(bosNotificationDetails(changes), changes);
  }

  function publishBosNotification(notification, changes) {
    appendAlertLog(changes.map((change) => notificationHistoryEntry({
      title: `${change.symbol}: ${appStructureLabel(change.nextStatus)}`,
      message: change.previousStatus
        ? `BOS changed from ${appStructureLabel(change.previousStatus)} to ${appStructureLabel(change.nextStatus)}.`
        : `BOS is now ${appStructureLabel(change.nextStatus)}.`,
      kind: "notification",
      symbol: change.symbol,
      source: "bos-monitor",
      payload: {
        ...notification,
        status: change.nextStatus,
        previousStatus: change.previousStatus,
        structureTime: change.structureTime,
        watchlistName: change.watchlistName,
      },
    })));
    addNotification({
      title: notification.title,
      message: notification.body,
      kind: "bos",
    });
    showBosDeviceNotification(notification);
  }

  function notifySpyCurlUpdate(nextSpyQuote) {
    const position = emaCloudPosition(nextSpyQuote);
    const signature = position.status === "Inside" ? `${position.setup || "Curl Watch"}:${position.bias || "Wait"}` : "";
    const previousSignature = lastSpyCurlSignature.current;
    lastSpyCurlSignature.current = signature;
    if (!signature || previousSignature === null || previousSignature === signature) return;
    publishSpyCurlNotification(spyCurlNotificationDetails(position));
  }

  function publishSpyCurlNotification(notification) {
    appendAlertLog([
      notificationHistoryEntry({
        title: notification.title,
        message: notification.body,
        kind: "notification",
        symbol: notification.targetSymbol,
        source: "spy-curl-watch",
        payload: notification,
      }),
    ]);
    addNotification({
      title: notification.title,
      message: notification.body,
      kind: "spy",
    });
    showSpyDeviceNotification(notification);
  }

  function notifyScannerUpdate(nextRows) {
    const nextByKey = Object.fromEntries(nextRows.map((row) => [scannerRowKey(row), row]));
    lastScannerRows.current = nextByKey;
    return;
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

  function handleInsiderData(payload) {
    if (payload?.secPending) return;
    const records = Array.isArray(payload?.alertRecords)
      ? payload.alertRecords
      : Array.isArray(payload?.records)
        ? payload.records
        : [];
    const nextKeys = records.map(insiderRecordKey).filter(Boolean);

    const previousKeys = new Set(insiderSeenRecordsRef.current);
    const unseenRecords = records.filter((record) => !previousKeys.has(insiderRecordKey(record)));
    insiderSeenRecordsRef.current = saveInsiderSeenRecords([
      INSIDER_BASELINE_SENTINEL,
      ...nextKeys,
      ...insiderSeenRecordsRef.current,
    ]);
    if (!previousKeys.size || !unseenRecords.length) return;

    const notification = insiderNotificationDetails(unseenRecords);
    appendAlertLog([
      notificationHistoryEntry({
        title: notification.title,
        message: notification.body,
        kind: "notification",
        symbol: notification.targetSymbol,
        source: "insider-monitor",
        payload: notification,
      }),
    ]);
    addNotification({
      title: notification.title,
      message: notification.body,
      kind: "insider",
    });
    showInsiderDeviceNotification(notification);
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
      if (isTabDataEnabled("alerts")) {
        postJson("/api/notifications/history", { items: freshEntries }).catch(() => {});
      }
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
    const requestedPage = page === "home" || page === "spy" ? "mtfs" : page;
    const nextPage = visibleTabsRef.current[requestedPage] !== false ? requestedPage : firstVisibleTab(visibleTabsRef.current);
    setActivePage(nextPage);
    const hash = nextPage === "alerts"
      ? "#alerts"
      : nextPage === "mtfs"
        ? "#mtfs"
        : nextPage === "sectors"
          ? "#sectors"
          : nextPage === "insiders"
            ? "#insiders"
            : nextPage === "charts"
              ? "#charts"
              : nextPage === "watchlist"
                ? "#watchlist"
                : "";
    window.history.replaceState(null, "", hash || window.location.pathname);
  }

  function isTabDataEnabled(dataKey) {
    return APP_TABS.some((tab) => tab.data === dataKey && visibleTabsRef.current[tab.id] !== false);
  }

  function updateVisibleTabs(tabId, enabled) {
    const normalized = normalizeVisibleTabs({ ...visibleTabsRef.current, [tabId]: enabled });
    setVisibleTabs(normalized);
    visibleTabsRef.current = normalized;
    saveVisibleTabs(normalized);
    if (normalized[activePage] === false) {
      navigatePage(firstVisibleTab(normalized));
    }
  }

  function addNotification({ title, message, kind = "update" }) {
    setNotifications((current) => {
      const nextItem = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        title,
        message,
        kind,
        read: false,
        createdAt: new Date().toISOString(),
      };
      const nextKey = notificationContentKey(nextItem);
      return [
        nextItem,
        ...current.filter((item) => notificationContentKey(item) !== nextKey),
      ].slice(0, MAX_NOTIFICATIONS);
    });
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
        ? { ...watchlist, symbols: normalizeSymbols([...watchlist.symbols, ...incoming]).slice(0, MAX_WATCHLIST_SYMBOLS) }
        : watchlist
    )));
    setSymbolInputs((current) => ({ ...current, [watchlistTab]: "" }));
    lastMtfSignature.current = { ...lastMtfSignature.current, [watchlistTab]: null };
  }

  function removeSymbolFromWatchlist(symbol, tab = watchlistTab) {
    const normalizedSymbol = String(symbol || "").trim().toUpperCase();
    updateWatchlists((current) => current.map((watchlist) => (
      watchlist.id === tab
        ? { ...watchlist, symbols: watchlist.symbols.filter((item) => String(item || "").trim().toUpperCase() !== normalizedSymbol) }
        : watchlist
    )));
    setQuotesByTab((current) => ({
      ...current,
      [tab]: (current[tab] || []).filter((quote) => String(quote.symbol || "").trim().toUpperCase() !== normalizedSymbol),
    }));
    lastMtfSignature.current = { ...lastMtfSignature.current, [tab]: null };
    const tabRows = { ...(lastMtfRows.current[tab] || {}) };
    delete tabRows[normalizedSymbol];
    lastMtfRows.current = { ...lastMtfRows.current, [tab]: tabRows };
    const nextBosRows = { ...lastBosRows.current };
    delete nextBosRows[normalizedSymbol];
    lastBosRows.current = nextBosRows;
    saveBosState(nextBosRows);
    dismissNewMtfRow(tab, normalizedSymbol);
  }

  function moveSymbolsBetweenWatchlists(symbols, fromId, toId) {
    const source = watchlistsRef.current.find((watchlist) => watchlist.id === fromId);
    const destination = watchlistsRef.current.find((watchlist) => watchlist.id === toId);
    if (!source || !destination || source.id === destination.id) return false;

    const sourceSymbols = new Set(source.symbols.map((symbol) => String(symbol || "").toUpperCase()));
    const destinationSymbols = new Set(destination.symbols.map((symbol) => String(symbol || "").toUpperCase()));
    const requested = normalizeSymbols(symbols).filter((symbol) => sourceSymbols.has(symbol));
    if (!requested.length) return false;

    const newDestinationSymbols = requested.filter((symbol) => !destinationSymbols.has(symbol));
    const availableSlots = MAX_WATCHLIST_SYMBOLS - destination.symbols.length;
    if (newDestinationSymbols.length > availableSlots) {
      setAppAlert(
        `${destination.name} has room for ${Math.max(availableSlots, 0)} more symbol${availableSlots === 1 ? "" : "s"}. Reduce the selection and try again.`,
        "warning",
      );
      return false;
    }

    const movedSymbols = new Set(requested);
    updateWatchlists((current) => current.map((watchlist) => {
      if (watchlist.id === fromId) {
        return { ...watchlist, symbols: watchlist.symbols.filter((symbol) => !movedSymbols.has(String(symbol || "").toUpperCase())) };
      }
      if (watchlist.id === toId) {
        return { ...watchlist, symbols: normalizeSymbols([...watchlist.symbols, ...requested]) };
      }
      return watchlist;
    }));

    setQuotesByTab((current) => {
      const movedQuotes = (current[fromId] || []).filter((quote) => movedSymbols.has(String(quote.symbol || "").toUpperCase()));
      const destinationQuoteSymbols = new Set((current[toId] || []).map((quote) => String(quote.symbol || "").toUpperCase()));
      return {
        ...current,
        [fromId]: (current[fromId] || []).filter((quote) => !movedSymbols.has(String(quote.symbol || "").toUpperCase())),
        [toId]: [
          ...(current[toId] || []),
          ...movedQuotes.filter((quote) => !destinationQuoteSymbols.has(String(quote.symbol || "").toUpperCase())),
        ],
      };
    });
    setUpdatedTextByTab((current) => ({
      ...current,
      [fromId]: `Moved ${requested.length} symbol${requested.length === 1 ? "" : "s"} to ${destination.name}`,
      [toId]: `Received ${requested.length} symbol${requested.length === 1 ? "" : "s"} from ${source.name}`,
    }));
    lastMtfSignature.current = {
      ...lastMtfSignature.current,
      [fromId]: null,
      [toId]: null,
    };

    const sourceRows = { ...(lastMtfRows.current[fromId] || {}) };
    const destinationRows = { ...(lastMtfRows.current[toId] || {}) };
    requested.forEach((symbol) => {
      if (sourceRows[symbol]) destinationRows[symbol] = sourceRows[symbol];
      delete sourceRows[symbol];
    });
    lastMtfRows.current = {
      ...lastMtfRows.current,
      [fromId]: sourceRows,
      [toId]: destinationRows,
    };

    const nextBosRows = { ...lastBosRows.current };
    requested.forEach((symbol) => {
      if (nextBosRows[symbol]?.watchlistId === fromId) {
        nextBosRows[symbol] = {
          ...nextBosRows[symbol],
          watchlistId: toId,
          watchlistName: destination.name,
        };
      }
    });
    lastBosRows.current = nextBosRows;
    saveBosState(nextBosRows);
    setNewMtfRows((current) => {
      const next = { ...current };
      requested.forEach((symbol) => {
        delete next[mtfRowId(fromId, symbol)];
      });
      return next;
    });
    setAppAlert(
      `Moved ${requested.length} symbol${requested.length === 1 ? "" : "s"} from ${source.name} to ${destination.name}.`,
      "success",
    );
    return true;
  }

  function clearWatchlist(id = watchlistTab) {
    const watchlist = watchlistsRef.current.find((item) => item.id === id);
    if (!watchlist?.symbols?.length) return;
    const confirmed = window.confirm(`Clear all ${watchlist.symbols.length} symbols from ${watchlist.name}?`);
    if (!confirmed) return;
    updateWatchlists((current) => current.map((item) => (
      item.id === id ? { ...item, symbols: [] } : item
    )));
    setQuotesByTab((current) => ({ ...current, [id]: [] }));
    setUpdatedTextByTab((current) => ({ ...current, [id]: "Watchlist cleared" }));
    setSymbolInputs((current) => ({ ...current, [id]: "" }));
    lastMtfSignature.current = { ...lastMtfSignature.current, [id]: null };
    lastMtfRows.current = { ...lastMtfRows.current, [id]: {} };
    const removedSymbols = new Set((watchlist.symbols || []).map((symbol) => String(symbol || "").toUpperCase()));
    const nextBosRows = Object.fromEntries(
      Object.entries(lastBosRows.current || {}).filter(([symbol, row]) => (
        !removedSymbols.has(symbol) || row.watchlistId !== id
      )),
    );
    lastBosRows.current = nextBosRows;
    saveBosState(nextBosRows);
    setNewMtfRows((current) => Object.fromEntries(
      Object.entries(current).filter(([rowId]) => !rowId.startsWith(`${id}:`)),
    ));
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
    const removedSymbols = new Set((watchlist.symbols || []).map((symbol) => String(symbol || "").toUpperCase()));
    const nextBosRows = Object.fromEntries(
      Object.entries(lastBosRows.current || {}).filter(([symbol, row]) => (
        !removedSymbols.has(symbol) || row.watchlistId !== id
      )),
    );
    lastBosRows.current = nextBosRows;
    saveBosState(nextBosRows);
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
    setWatchlistTab((current) => (
      current === ALL_WATCHLISTS_TAB_ID || next.some((item) => item.id === current) ? current : OG_WATCHLIST_ID
    ));
  }

  async function refreshAppMarketData({ showLoading = true, force = false } = {}) {
    if (!accountsConfirmedRef.current) return;
    await refreshWatchlists({ showLoading });
    await refreshAllPrices({ showLoading, force });
    await refreshSectorPrices({ showLoading: false, force });
  }

  function selectHomeView(view) {
    setHomeView(view);
    if (!accountsConfirmedRef.current || loading.prices) return;
    if (view === "spy" && !spyQuote) {
      refreshAllPrices({ showLoading: false });
    } else if (view === "watchlist" && !(quotesByTab[contextWatchlist?.id] || []).length) {
      refreshAllPrices({ showLoading: false });
    }
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

  function showInsiderDeviceNotification(notification) {
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

  function showBosDeviceNotification(notification) {
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

  function showSpyDeviceNotification(notification) {
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
      const nextState = await enableNotifications();
      setNotificationState(nextState);
      if (nextState.permission === "granted") {
        addNotification({
          title: "Push notifications enabled",
          message: nextState.webPushConfigured && nextState.subscribed
            ? "Railway can send MTF and insider push alerts."
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
      if (isTabDataEnabled("watchlists") && !passiveMarketTimer.current) {
        passiveMarketTimer.current = setInterval(() => {
          if (isMarketRefreshWindow()) refreshAppMarketData({ showLoading: false, force: true });
        }, PASSIVE_MARKET_REFRESH_INTERVAL_MS);
      }
    };
  }

  function startBackgroundRefresh() {
    if (!accountsConfirmedRef.current) return;
    if (isTabDataEnabled("watchlists") && !passiveMarketTimer.current) {
      passiveMarketTimer.current = setInterval(() => {
        if (isMarketRefreshWindow()) refreshAppMarketData({ showLoading: false, force: true });
      }, PASSIVE_MARKET_REFRESH_INTERVAL_MS);
    }
    if (isTabDataEnabled("insiders") && !insiderRefreshTimer.current) {
      checkRecentInsiderFilings();
      insiderRefreshTimer.current = setInterval(checkRecentInsiderFilings, INSIDER_REFRESH_INTERVAL_MS);
    }
  }

  async function checkRecentInsiderFilings() {
    if (!isTabDataEnabled("insiders")) return;
    try {
      const payload = await getJson("/api/insiders/qqq/recent");
      handleInsiderData(payload);
    } catch {
      // The next polling cycle retries transient SEC failures.
    }
  }

  async function confirmAccountsAndStart() {
    loadAlertHistory();
    const confirmed = await refreshShell();
    if (!confirmed) return;
    loadAlertHistory();
    loadNotificationState()
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
      if (insiderRefreshTimer.current) clearInterval(insiderRefreshTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!accountsConfirmedAt || initialMarketLoadStarted.current) return;
    initialMarketLoadStarted.current = true;
    refreshAppMarketData({ showLoading: true, force: true });
  }, [accountsConfirmedAt]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return undefined;
    function handleServiceWorkerMessage(event) {
      if (event.data?.type !== "MTF_PUSH_UPDATE") return;
      const payload = event.data.payload || {};
      const targetSymbol = payload.targetSymbol || payload.target_symbol;
      if (targetSymbol && payload.kind !== "insider") focusMtfSymbol(targetSymbol);
      addNotification({
        title: payload.title || "Push alert received",
        message: payload.body || "Push update received.",
        kind: "push",
      });
      appendAlertLog([
        notificationHistoryEntry({
          title: payload.title || "Push alert received",
          message: payload.body || "Push update received.",
          kind: "push",
          symbol: targetSymbol,
          source: "service-worker",
          payload,
        }),
      ]);
      if (accountsConfirmedRef.current) {
        refreshAppMarketData({ showLoading: false });
        if (isTabDataEnabled("alerts")) loadAlertHistory({ showLoading: false });
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
    visibleTabsRef.current = visibleTabs;
    saveVisibleTabs(visibleTabs);
    if (visibleTabs[activePage] === false) {
      navigatePage(firstVisibleTab(visibleTabs));
    }
    if (!isTabDataEnabled("insiders") && insiderRefreshTimer.current) {
      clearInterval(insiderRefreshTimer.current);
      insiderRefreshTimer.current = null;
    }
    if (!isTabDataEnabled("watchlists") && passiveMarketTimer.current) {
      clearInterval(passiveMarketTimer.current);
      passiveMarketTimer.current = null;
    }
    if (accountsConfirmedRef.current) startBackgroundRefresh();
  }, [activePage, visibleTabs]);

  useEffect(() => {
    if (!focusedMtfSymbol || !allTouchedMtfs.some((quote) => quote.symbol === focusedMtfSymbol)) return;
    window.requestAnimationFrame(() => {
      document.querySelector(`[data-mtf-symbol="${focusedMtfSymbol}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [allTouchedMtfs, focusedMtfSymbol]);

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
    syncNotificationPreferences().catch(() => {});
  }, [notificationState.appEnabled]);

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
            onVisibleTabChange={updateVisibleTabs}
            onApplyRisk={refreshAllPrices}
            onAutoTradeChange={updateAutoTradeSettings}
            onRiskChange={updateRiskSettings}
            onToggleStrategy={toggleStrategy}
            riskSettings={riskSettings}
            strategyState={strategyState}
            visibleTabs={visibleTabs}
          />
        )}
        visibleTabs={visibleTabs}
      />
      {pageLoading ? (
        <div className="loading-blocker" aria-live="polite" aria-busy="true">
          <div className="page-loader">
            <span className="loading-spinner" aria-hidden="true"></span>
            <strong>Loading</strong>
          </div>
        </div>
      ) : null}
      <main className={`shell ${activePage === "mtfs" || activePage === "home" ? "mtf-shell" : ""}`}>
        {alert && activePage !== "charts" ? <div className={`alert app-alert ${alertKind}`}>{alert}</div> : null}

        {activePage === "alerts" ? (
          <AlertLogPage
            alertLog={alertLog}
            onClear={clearAlertLog}
            onSelectSymbol={(symbol) => {
              focusMtfSymbol(symbol);
              navigatePage("mtfs");
            }}
            structureBySymbol={structureBySymbol}
          />
        ) : activePage === "mtfs" ? (
          <MtfPage
            buyState={buyState}
            focusedSymbol={focusedMtfSymbol}
            mtfQuotes={allTouchedMtfs}
            onBuy={buyMtfQuote}
            onDismissNew={(quote) => dismissNewMtfRow(quote.watchlist_id, quote.symbol)}
          />
        ) : activePage === "sectors" ? (
          <SectorsPage
            groups={sectorGroups}
            updatedText={sectorUpdatedText}
            loading={loading.prices}
            onRefresh={() => refreshSectorPrices({ force: true })}
          />
        ) : activePage === "insiders" ? (
          <InsiderBuyingPage onDataLoaded={handleInsiderData} />
        ) : activePage === "charts" ? (
          <ChartsPage quotesByTab={quotesByTab} watchlists={watchlists} />
        ) : activePage === "watchlist" ? (
          <WatchlistWorkspace
            activeTab={watchlistTab}
            allWatchlistCount={allWatchlistSymbols.length}
            contextWatchlist={contextWatchlist}
            isAllWatchlistsTab={isAllWatchlistsTab}
            loading={loading.prices || loading.watchlists}
            onAddSymbols={addSymbolsToActiveWatchlist}
            onAddTab={addWatchlist}
            onClearWatchlist={clearWatchlist}
            onDeleteTab={deleteWatchlist}
            onMoveSymbols={moveSymbolsBetweenWatchlists}
            onRemoveSymbol={removeSymbolFromWatchlist}
            onSwitchTab={switchWatchlistTab}
            onSymbolInput={(tab, value) => setSymbolInputs((current) => ({ ...current, [tab]: value }))}
            onToggleAutoTrade={toggleWatchlistAutoTrade}
            symbolInput={symbolInputs[watchlistTab] || ""}
            trendBuckets={trendBuckets}
            updatedText={updatedText}
            watchlists={watchlists}
          />
        ) : (
          <MtfPage
            buyState={buyState}
            focusedSymbol={focusedMtfSymbol}
            mtfQuotes={allTouchedMtfs}
            onBuy={buyMtfQuote}
            onDismissNew={(quote) => dismissNewMtfRow(quote.watchlist_id, quote.symbol)}
          />
        )}
        <HiddenLegacyPanels />
      </main>
    </>
  );
}

function SectorsPage({ groups, updatedText, loading, onRefresh }) {
  const allRows = groups.flatMap((group) => group.rows || []);
  const longCount = groups.filter((group) => group.direction === "Long").length;
  const shortCount = groups.filter((group) => group.direction === "Short").length;

  return (
    <section className="sectors-page" aria-label="Sector ETF movers">
      <div className="scanner-hero sectors-hero">
        <div>
          <span className="muted">SOXL · XLV · CIBR · XLF · XLK</span>
          <h2>Sectors</h2>
        </div>
        <div className="live-price-actions">
          <button type="button" onClick={onRefresh} disabled={loading}>
            {loading ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </div>
      <div className="scanner-metric-grid sectors-metric-grid">
        <ScannerMetric label="ETFs long" value={longCount} tone="long" />
        <ScannerMetric label="ETF shorts" value={shortCount} tone="short" />
        <ScannerMetric label="Stock setups" value={allRows.length} tone="risk" />
      </div>
      <div className="sector-group-grid">
        {groups.length ? groups.map((group) => (
          <section key={group.etf} className={`price-bucket sectors-movers-bucket sector-direction-${String(group.direction || "neutral").toLowerCase()}`}>
            <div className="bucket-heading">
              <div className="bucket-title">
                <h3>
                  {group.etf}
                  <small className={`sector-direction-pill ${String(group.direction || "neutral").toLowerCase()}`}>{group.direction || "Neutral"}</small>
                </h3>
                <p>{group.name} · ETF {formatSignedPercent(group.etf_move_pct)} · {updatedText}</p>
              </div>
              <span>{(group.rows || []).length}</span>
            </div>
            <div className="live-price-table-wrap">
              <table className="live-price-table sectors-table">
                <thead>
                  <tr>
                    <th>Stock</th>
                    <th>Side</th>
                    <th>Last</th>
                    <th>Prev</th>
                    <th>Move</th>
                    <th>8 EMA</th>
                  </tr>
                </thead>
                <tbody>
                  {(group.rows || []).length ? group.rows.map((row) => (
                    <tr key={`${group.etf}-${row.symbol}`} className={`stock-row sector-${moveTone(row.move_pct)}`}>
                      <td data-label="Stock"><strong>{row.symbol}</strong></td>
                      <td data-label="Side"><span className={`direction-pill ${String(row.action || "Wait").toLowerCase()}`}>{row.action || "Wait"}</span></td>
                      <td data-label="Last" className="price-cell">{formatPrice(row.price)}</td>
                      <td data-label="Prev Close" className="price-cell">{formatPrice(row.previous_close)}</td>
                      <td data-label="Move" className={`price-cell sector-move-cell ${moveTone(row.move_pct)}`}>{formatSignedPercent(row.move_pct)}</td>
                      <td data-label="8 EMA"><SectorEmaTag distance={row.ema_8_distance} /></td>
                    </tr>
                  )) : (
                    <tr className="scanner-empty-row"><td colSpan="6">No underlying movers loaded.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )) : (
          <section className="price-bucket sectors-movers-bucket">
            <div className="bucket-heading">
              <div className="bucket-title">
                <h3>Underlying Movers</h3>
                <p>{updatedText}</p>
              </div>
              <span>0</span>
            </div>
            <div className="live-price-table-wrap">
              <table className="live-price-table sectors-table">
                <tbody>
                  <tr className="scanner-empty-row"><td>No sector prices loaded yet.</td></tr>
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </section>
  );
}

function SectorEmaTag({ distance }) {
  if (!distance) return <span className="sector-ema-tag unknown">-</span>;
  const dollars = Number(distance.distance);
  const distancePct = Math.abs(Number(distance.distance_pct));
  const proximity = !Number.isFinite(distancePct)
    ? "unknown"
    : distancePct <= 0.35
      ? "near"
      : distancePct <= 1
        ? "mid"
        : "far";
  const label = Number.isFinite(dollars)
    ? `${dollars > 0 ? "+" : ""}$${Math.abs(dollars).toFixed(2)}`
    : "-";
  return (
    <span
      className={`sector-ema-tag ${proximity}`}
      title={`8 EMA ${formatPrice(distance.ema)} · ${distance.status || ""}`}
    >
      {label}
    </span>
  );
}

function moveTone(value) {
  const numeric = Number(value);
  if (numeric > 0) return "up";
  if (numeric < 0) return "down";
  return "flat";
}

function formatSignedPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "-";
  const sign = numeric > 0 ? "+" : "";
  return `${sign}${numeric.toFixed(2)}%`;
}

function ChartsPage({ quotesByTab, watchlists }) {
  const chartGroups = useMemo(() => chartGroupsFromWatchlists(watchlists), [watchlists]);
  const chartSymbols = useMemo(
    () => normalizeSymbols(chartGroups.flatMap((group) => group.symbols)),
    [chartGroups]
  );
  const [chartLevelQuotes, setChartLevelQuotes] = useState({});
  const quoteMap = useMemo(
    () => chartQuoteMap(watchlists, quotesByTab, chartLevelQuotes),
    [chartLevelQuotes, quotesByTab, watchlists]
  );
  const chartItems = useMemo(
    () => chartGroups.flatMap((group) => group.symbols.map((symbol) => ({
      color: group.color,
      groupId: group.id,
      groupName: group.name,
      quote: quoteMap.get(`${group.id}:${symbol}`) || quoteMap.get(symbol) || null,
      symbol,
    }))),
    [chartGroups, quoteMap]
  );
  const [activeChartIndex, setActiveChartIndex] = useState(null);
  const activeChart = activeChartIndex == null ? null : chartItems[activeChartIndex];

  useEffect(() => {
    if (activeChartIndex != null && activeChartIndex >= chartItems.length) {
      setActiveChartIndex(chartItems.length ? chartItems.length - 1 : null);
    }
  }, [activeChartIndex, chartItems.length]);

  useEffect(() => {
    if (!chartSymbols.length) {
      setChartLevelQuotes({});
      return undefined;
    }
    let cancelled = false;
    Promise.all(chartSymbolChunks(chartSymbols, 25).map((symbols) => {
      const query = new URLSearchParams({
        symbols: symbols.join(","),
        force: "true",
      });
      return getJson(`/api/webull/live-prices?${query.toString()}`);
    }))
      .then((payloads) => {
        if (cancelled) return;
        const quotes = payloads.flatMap((payload) => payload.ok ? (payload.quotes || []) : []);
        if (!quotes.length) return;
        setChartLevelQuotes(Object.fromEntries(
          quotes
            .map((quote) => [String(quote.symbol || "").trim().toUpperCase(), quote])
            .filter(([symbol]) => symbol)
        ));
      })
      .catch(() => {
        if (!cancelled) setChartLevelQuotes({});
      });
    return () => {
      cancelled = true;
    };
  }, [chartSymbols]);

  function showPreviousChart() {
    setActiveChartIndex((index) => {
      if (index == null || !chartItems.length) return index;
      return (index - 1 + chartItems.length) % chartItems.length;
    });
  }

  function showNextChart() {
    setActiveChartIndex((index) => {
      if (index == null || !chartItems.length) return index;
      return (index + 1) % chartItems.length;
    });
  }

  return (
    <section className="charts-page" aria-label="Watchlist TradingView charts">
      {chartGroups.length ? (
        <div className="watchlist-chart-board">
          <div className="watchlist-chart-legend" aria-label="Watchlist chart groups">
            {chartGroups.map((group) => (
              <span key={group.id} style={{ "--watchlist-color": group.color }}>
                <b>{group.name}</b>
                <em>{group.symbols.length}</em>
              </span>
            ))}
          </div>
          <div className="tradingview-chart-grid">
            {chartItems.map((item, chartIndex) => (
              <TradingViewChart
                color={item.color}
                groupName={item.groupName}
                key={`${item.groupId}-${item.symbol}`}
                onOpen={() => setActiveChartIndex(chartIndex)}
                quote={item.quote}
                symbol={item.symbol}
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="charts-empty-state">
          <strong>No watchlist symbols yet.</strong>
          <span>Add tickers to a watchlist, then they will appear here.</span>
        </div>
      )}
      {activeChart ? (
        <ChartModal
          chart={activeChart}
          current={activeChartIndex + 1}
          key={`${activeChart.groupId}-${activeChart.symbol}`}
          onClose={() => setActiveChartIndex(null)}
          onNext={showNextChart}
          onPrevious={showPreviousChart}
          total={chartItems.length}
        />
      ) : null}
    </section>
  );
}

function chartGroupsFromWatchlists(watchlists) {
  return watchlists
    .map((watchlist, index) => {
      const symbols = normalizeSymbols(watchlist.symbols || []);
      return {
        color: CHART_GROUP_COLORS[index % CHART_GROUP_COLORS.length],
        id: watchlist.id || `watchlist-${index}`,
        name: watchlist.name || "Watchlist",
        symbols,
      };
    })
    .filter((group) => group.symbols.length);
}

function chartQuoteMap(watchlists, quotesByTab, chartLevelQuotes = {}) {
  const map = new Map();
  for (const [symbol, quote] of Object.entries(chartLevelQuotes)) {
    const normalizedSymbol = String(symbol || "").trim().toUpperCase();
    if (normalizedSymbol) map.set(normalizedSymbol, quote);
  }
  for (const watchlist of watchlists) {
    for (const quote of quotesByTab[watchlist.id] || []) {
      const symbol = String(quote.symbol || "").trim().toUpperCase();
      if (!symbol) continue;
      map.set(`${watchlist.id}:${symbol}`, quote);
      if (!map.has(symbol)) map.set(symbol, quote);
    }
  }
  return map;
}

function chartSymbolChunks(symbols, size) {
  const chunks = [];
  for (let index = 0; index < symbols.length; index += size) {
    chunks.push(symbols.slice(index, index + size));
  }
  return chunks;
}

function TradingViewChart({ color, groupName, onOpen, quote, symbol }) {
  const chartUrl = tradingViewEmbedUrl(symbol);

  return (
    <article
      className="tradingview-chart-card"
      style={{ "--watchlist-color": color }}
      aria-label={`${symbol} TradingView chart`}
    >
      <div className="tradingview-chart-label">{symbol}</div>
      <div className="tradingview-watchlist-label">{groupName}</div>
      <ChartReferenceLines quote={quote} />
      <iframe
        className="tradingview-widget-frame"
        title={`${symbol} chart`}
        src={chartUrl}
        allowFullScreen
      />
      <button
        type="button"
        className="chart-open-hit-area"
        onClick={onOpen}
        aria-label={`Open ${symbol} chart`}
      />
    </article>
  );
}

function ChartModal({ chart, current, onClose, onNext, onPrevious, total }) {
  const chartUrl = tradingViewEmbedUrl(chart.symbol);

  return (
    <div className="chart-modal-backdrop" role="presentation" onClick={onClose} onMouseDown={onClose}>
      <section
        className="chart-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${chart.symbol} enlarged chart`}
        onClick={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="chart-modal-toolbar">
          <div>
            <strong>{chart.symbol}</strong>
            <span>{chart.groupName}</span>
          </div>
          <div className="chart-modal-actions">
            <button type="button" className="secondary-button" onClick={onPrevious}>Previous</button>
            <span>{current} / {total}</span>
            <button type="button" className="secondary-button" onClick={onNext}>Next</button>
            <button type="button" className="secondary-button" onClick={onClose} aria-label="Close chart">Close</button>
          </div>
        </div>
        <iframe
          key={`${chart.groupId}-${chart.symbol}`}
          className="chart-modal-frame"
          title={`${chart.symbol} enlarged chart`}
          src={chartUrl}
          allowFullScreen
        />
        <ChartReferenceLines large quote={chart.quote} />
      </section>
    </div>
  );
}

function ChartReferenceLines({ large = false, quote }) {
  const levels = chartReferenceLevels(quote);
  if (!levels.length) return null;
  return (
    <div className={`chart-reference-lines ${large ? "large" : ""}`} aria-hidden="true">
      {levels.map((level) => (
        <span
          className={`chart-reference-line ${level.kind}`}
          key={level.key}
          style={{ "--line-color": level.color, "--line-top": `${level.top}%` }}
        >
          <b>{level.label}</b>
          <em>{formatLevelPrice(level.value)}</em>
        </span>
      ))}
    </div>
  );
}

function chartReferenceLevels(quote) {
  const rawLevels = [
    { key: "pmh", kind: "premarket", label: "PMH", value: quote?.premarket?.high, color: "#fbbf24" },
    { key: "pml", kind: "premarket", label: "PML", value: quote?.premarket?.low, color: "#fbbf24" },
    { key: "yh", kind: "yesterday", label: "YH", value: quote?.previous_day?.high, color: "#38bdf8" },
    { key: "yl", kind: "yesterday", label: "YL", value: quote?.previous_day?.low, color: "#38bdf8" },
    { key: "yc", kind: "close", label: "YC", value: quote?.previous_day?.close, color: "#f472b6" },
  ].map((level) => ({ ...level, value: Number(level.value) }))
    .filter((level) => Number.isFinite(level.value));
  if (!rawLevels.length) return [];
  const anchors = [
    ...rawLevels.map((level) => level.value),
    Number(quote?.scanner_price),
    Number(quote?.price),
  ].filter(Number.isFinite);
  const min = Math.min(...anchors);
  const max = Math.max(...anchors);
  const span = Math.max(max - min, max * 0.01, 1);
  const paddedMin = min - span * 0.1;
  const paddedMax = max + span * 0.1;
  return rawLevels.map((level) => ({
    ...level,
    top: Math.min(88, Math.max(12, ((paddedMax - level.value) / (paddedMax - paddedMin)) * 100)),
  }));
}

function formatLevelPrice(value) {
  if (!Number.isFinite(value)) return "";
  return value >= 1000 ? value.toLocaleString(undefined, { maximumFractionDigits: 0 }) : value.toFixed(2);
}

function tradingViewEmbedUrl(symbol) {
  const config = {
    autosize: true,
    symbol,
    interval: "5",
    range: "1D",
    timezone: "America/Chicago",
    theme: "dark",
    style: "1",
    locale: "en",
    backgroundColor: "#080d14",
    gridColor: "rgba(148, 163, 184, 0.12)",
    hide_top_toolbar: true,
    hide_side_toolbar: true,
    hide_legend: true,
    allow_symbol_change: true,
    calendar: false,
    details: false,
    hotlist: false,
    hide_volume: true,
    save_image: false,
    extended_hours: true,
    show_extended_hours: true,
    withdateranges: false,
    overrides: {
      "backgrounds.preMarket.color": "rgba(148, 163, 184, 0.18)",
      "backgrounds.postMarket.color": "rgba(148, 163, 184, 0.12)",
    },
    support_host: "https://www.tradingview.com",
    width: "100%",
    height: "100%",
  };
  return `${TRADINGVIEW_WIDGET_URL}?locale=en#${encodeURIComponent(JSON.stringify(config))}`;
}

function MtfPage({
  buyState,
  focusedSymbol,
  mtfQuotes,
  onBuy,
  onDismissNew,
}) {
  const totalCount = mtfQuotes.length;
  const [signalFilter, setSignalFilter] = useState("all");
  const [timeMode, setTimeMode] = useState("pm-live");
  const [query, setQuery] = useState("");
  const visibleQuotes = useMemo(() => {
    const normalizedQuery = query.trim().toUpperCase();
    return mtfQuotes.filter((quote) => {
      const signal = mtfPageSignal(quote);
      const matchesSignal = signalFilter === "all"
        || (signalFilter === "long" && signal === "Long")
        || (signalFilter === "wait" && signal !== "Long" && signal !== "Short");
      const matchesQuery = !normalizedQuery
        || String(quote.symbol || "").toUpperCase().includes(normalizedQuery)
        || String(quote.watchlist_name || "").toUpperCase().includes(normalizedQuery)
        || (quote.mtf_matches || []).some((match) => String(match.display_label || match.label || "").toUpperCase().includes(normalizedQuery));
      return matchesSignal && matchesQuery;
    });
  }, [mtfQuotes, query, signalFilter]);
  const longCount = mtfQuotes.filter((quote) => mtfPageSignal(quote) === "Long").length;
  const waitCount = mtfQuotes.filter((quote) => !["Long", "Short"].includes(mtfPageSignal(quote))).length;

  return (
    <section className="mtf-page global-mtf-panel">
      <div className="mtf-page-header">
        <div>
          <h2>MTF Touches Today</h2>
          <span>{visibleQuotes.length} of {totalCount}</span>
        </div>
        <div className="mtf-toolbar" aria-label="MTF touch filters">
          <div className="mtf-segmented" aria-label="Signal filter">
            <button type="button" className={signalFilter === "all" ? "active" : ""} onClick={() => setSignalFilter("all")}>All</button>
            <button type="button" className={signalFilter === "long" ? "active" : ""} onClick={() => setSignalFilter("long")}>Long <b>{longCount}</b></button>
            <button type="button" className={signalFilter === "wait" ? "active" : ""} onClick={() => setSignalFilter("wait")}>Wait <b>{waitCount}</b></button>
          </div>
          <div className="mtf-segmented" aria-label="Time window">
            <button type="button" className={timeMode === "pm-live" ? "active" : ""} onClick={() => setTimeMode("pm-live")}>PM -&gt; live</button>
            <button type="button" className={timeMode === "all-day" ? "active" : ""} onClick={() => setTimeMode("all-day")}>All day</button>
          </div>
          <label className="mtf-filter-field">
            <span>⌕</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter symbol..." />
          </label>
        </div>
      </div>

      <MtfTable
        buyState={buyState}
        compact
        hideHeading
        emptyText="No watchlist stocks have touched an MTF today."
        focusedSymbol={focusedSymbol}
        onDismissNew={onDismissNew}
        quotes={visibleQuotes}
        showWatchlist
      />
    </section>
  );
}

function mtfPageSignal(quote) {
  const actions = new Set((quote.mtf_matches || []).map((match) => match.trade_action).filter(Boolean));
  if (actions.has("Long") && !actions.has("Short")) return "Long";
  if (actions.has("Short") && !actions.has("Long")) return "Short";
  return "Wait";
}

function SpyComparisonPage({ loading, onRefresh, rows, spyQuote, updatedText }) {
  const spyPosition = emaCloudPosition(spyQuote);
  const spyTrend = emaCloudTrendLabel(spyPosition);
  const spyReady = Boolean(spyQuote && spyPosition.cloud);
  const playbook = spyPlaybook(spyPosition);
  const sections = spyComparisonSections(rows, spyQuote);

  return (
    <section className="spy-page global-mtf-panel">
      <div className="mtf-page-header">
        <div>
          <h2>v/s SPY</h2>
          <p className="muted">{updatedText}</p>
        </div>
        <button type="button" className="secondary-button" onClick={() => onRefresh()} disabled={loading}>
          {loading ? "Updating" : "Update"}
        </button>
      </div>

      <div className="spy-summary-grid" aria-label="SPY 5/12 EMA summary">
        <SummaryTile label="SPY 5/12" value={spyReady ? spyCloudDisplay(spyPosition) : "-"} />
        <SummaryTile label="Market Bias" value={spyReady ? spyTrend : "-"} />
        <SummaryTile label="Go To" value={spyReady ? playbook.focusLabel : "-"} />
      </div>

      <SpyDecisionBanner playbook={playbook} />

      <div className="spy-comparison-sections">
        {sections.map((section) => (
          <SpyComparisonTable
            key={section.id}
            rows={section.rows}
            spyQuote={spyQuote}
            title={section.title}
            subtitle={section.subtitle}
            tone={section.tone}
            badge={section.badge}
          />
        ))}
      </div>
    </section>
  );
}

function SpyComparisonInline({ rows, spyQuote, updatedText }) {
  const spyPosition = emaCloudPosition(spyQuote);
  const spyTrend = emaCloudTrendLabel(spyPosition);
  const spyReady = Boolean(spyQuote && spyPosition.cloud);
  const playbook = spyPlaybook(spyPosition);
  const sections = spyComparisonSections(rows, spyQuote);

  return (
    <div className="spy-inline-panel">
      <div className="spy-summary-grid compact" aria-label="SPY 5/12 EMA summary">
        <SummaryTile label="SPY 5/12" value={spyReady ? spyCloudDisplay(spyPosition) : "-"} />
        <SummaryTile label="Market Bias" value={spyReady ? spyTrend : "-"} />
        <SummaryTile label="Go To" value={spyReady ? playbook.focusLabel : "-"} />
      </div>
      <SpyDecisionBanner playbook={playbook} />
      <p className="muted">{updatedText}</p>
      <div className="spy-comparison-sections">
        {sections.map((section) => (
          <SpyComparisonTable
            key={section.id}
            rows={section.rows}
            spyQuote={spyQuote}
            title={section.title}
            subtitle={section.subtitle}
            tone={section.tone}
            badge={section.badge}
          />
        ))}
      </div>
    </div>
  );
}

function WatchlistWorkspace({
  activeTab,
  allWatchlistCount,
  contextWatchlist,
  isAllWatchlistsTab,
  loading,
  onAddSymbols,
  onAddTab,
  onClearWatchlist,
  onDeleteTab,
  onMoveSymbols,
  onRemoveSymbol,
  onSwitchTab,
  onSymbolInput,
  onToggleAutoTrade,
  symbolInput,
  trendBuckets,
  updatedText,
  watchlists,
}) {
  const moveTargets = useMemo(
    () => watchlists.filter((watchlist) => watchlist.id !== activeTab),
    [activeTab, watchlists],
  );
  const activeSymbols = contextWatchlist?.symbols || [];
  const [selectedSymbols, setSelectedSymbols] = useState([]);
  const [moveTargetId, setMoveTargetId] = useState("");
  const moveTarget = moveTargets.find((watchlist) => watchlist.id === moveTargetId) || moveTargets[0];
  const destinationSymbols = new Set((moveTarget?.symbols || []).map((symbol) => String(symbol || "").toUpperCase()));
  const selectedNewSymbolCount = selectedSymbols.filter((symbol) => !destinationSymbols.has(symbol)).length;
  const availableSlots = Math.max(0, MAX_WATCHLIST_SYMBOLS - (moveTarget?.symbols.length || 0));
  const hasDestinationRoom = selectedNewSymbolCount <= availableSlots;
  const allSymbolsSelected = activeSymbols.length > 0 && selectedSymbols.length === activeSymbols.length;

  useEffect(() => {
    setSelectedSymbols([]);
    setMoveTargetId(moveTargets[0]?.id || "");
  }, [activeTab]);

  useEffect(() => {
    if (!moveTargets.length) {
      setMoveTargetId("");
    } else if (!moveTargets.some((watchlist) => watchlist.id === moveTargetId)) {
      setMoveTargetId(moveTargets[0].id);
    }
  }, [moveTargetId, moveTargets]);

  useEffect(() => {
    const available = new Set(activeSymbols);
    setSelectedSymbols((current) => current.filter((symbol) => available.has(symbol)));
  }, [activeSymbols]);

  function toggleMoveSymbol(symbol) {
    setSelectedSymbols((current) => (
      current.includes(symbol)
        ? current.filter((item) => item !== symbol)
        : [...current, symbol]
    ));
  }

  function submitBulkMove(event) {
    event.preventDefault();
    if (!selectedSymbols.length || !moveTarget) return;
    if (onMoveSymbols(selectedSymbols, contextWatchlist.id, moveTarget.id)) {
      setSelectedSymbols([]);
    }
  }

  return (
    <div className="watchlist-workspace watchlist-design-page">
      <WatchlistTabs
        activeTab={activeTab}
        allCount={allWatchlistCount}
        isAllWatchlistsTab={isAllWatchlistsTab}
        onAddSymbols={onAddSymbols}
        onAddTab={onAddTab}
        onClearWatchlist={onClearWatchlist}
        onDeleteTab={onDeleteTab}
        loading={loading}
        onSymbolInput={onSymbolInput}
        onSwitchTab={onSwitchTab}
        onToggleAutoTrade={onToggleAutoTrade}
        selectedWatchlist={contextWatchlist}
        symbolInput={symbolInput}
        watchlists={watchlists}
      />
      <div className="section-heading">
        <div>
          <h2>{contextWatchlist?.name || "Watchlist"}</h2>
          <p className="muted">{updatedText}</p>
        </div>
      </div>
      {isAllWatchlistsTab ? null : (
        <section className="watchlist-bulk-move" aria-label="Bulk move symbols">
          <div className="bulk-move-heading">
            <div>
              <h3>Move symbols</h3>
              <span>{selectedSymbols.length} selected</span>
            </div>
            <button
              type="button"
              className="bulk-select-all"
              onClick={() => setSelectedSymbols(allSymbolsSelected ? [] : [...activeSymbols])}
              disabled={!activeSymbols.length}
            >
              {allSymbolsSelected ? "Clear selection" : "Select all"}
            </button>
          </div>
          {activeSymbols.length ? (
            <div className="bulk-symbol-options" aria-label={`Symbols in ${contextWatchlist?.name || "watchlist"}`}>
              {activeSymbols.map((symbol) => (
                <label key={symbol} className={`bulk-symbol-option ${selectedSymbols.includes(symbol) ? "selected" : ""}`}>
                  <input
                    type="checkbox"
                    checked={selectedSymbols.includes(symbol)}
                    onChange={() => toggleMoveSymbol(symbol)}
                  />
                  <span>{symbol}</span>
                </label>
              ))}
            </div>
          ) : (
            <p className="bulk-move-empty">No symbols to move.</p>
          )}
          <form className="bulk-move-controls" onSubmit={submitBulkMove}>
            <label>
              <span>Move to</span>
              <select
                value={moveTarget?.id || ""}
                onChange={(event) => setMoveTargetId(event.target.value)}
                disabled={!moveTargets.length}
              >
                {moveTargets.length ? moveTargets.map((watchlist) => (
                  <option key={watchlist.id} value={watchlist.id}>
                    {watchlist.name} ({watchlist.symbols.length}/{MAX_WATCHLIST_SYMBOLS})
                  </option>
                )) : (
                  <option value="">Create another watchlist first</option>
                )}
              </select>
            </label>
            <span className={`bulk-move-capacity ${hasDestinationRoom ? "" : "warning"}`} aria-live="polite">
              {moveTarget
                ? `${availableSlots} open slot${availableSlots === 1 ? "" : "s"}`
                : "No destination"}
            </span>
            <button
              type="submit"
              disabled={loading || !selectedSymbols.length || !moveTarget || !hasDestinationRoom}
            >
              Move {selectedSymbols.length || ""}
            </button>
          </form>
        </section>
      )}
      <div className="trend-price-grid">
        {isAllWatchlistsTab ? (
          <>
            <SymbolTagBucket title="Bullish" quotes={trendBuckets.bullish} kind="bullish" />
            <SymbolTagBucket title="Bearish" quotes={trendBuckets.bearish} kind="bearish" />
          </>
        ) : (
          <>
            <PriceBucket compact title="Bullish" quotes={trendBuckets.bullish} kind="bullish" onRemoveSymbol={(symbol) => onRemoveSymbol(symbol, contextWatchlist?.id)} />
            <PriceBucket compact title="Bearish" quotes={trendBuckets.bearish} kind="bearish" onRemoveSymbol={(symbol) => onRemoveSymbol(symbol, contextWatchlist?.id)} />
          </>
        )}
      </div>
    </div>
  );
}

function SymbolTagBucket({ title, quotes, kind }) {
  const sortedQuotes = useMemo(
    () => [...quotes].sort((left, right) => String(left.symbol || "").localeCompare(String(right.symbol || ""), undefined, { numeric: true, sensitivity: "base" })),
    [quotes],
  );
  return (
    <section className={`price-bucket compact-watchlist-bucket symbol-tag-bucket watchlist-${kind}`}>
      <div className="bucket-heading">
        <h3>{title}</h3>
        <span>{sortedQuotes.length}</span>
      </div>
      {sortedQuotes.length ? (
        <div className="symbol-tag-grid" aria-label={`${title} symbols`}>
          {sortedQuotes.map((quote) => (
            <span key={quote.symbol} className="symbol-tag">{quote.symbol}</span>
          ))}
        </div>
      ) : (
        <div className="symbol-tag-empty">No {kind} stocks right now.</div>
      )}
    </section>
  );
}

function AutoTradesPage({ accountId, alert, loading, orders, onRefresh, structureBySymbol }) {
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
      <OrderBucket title={activeTable.label} items={visibleOrders} structureBySymbol={structureBySymbol} />
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

function OrderBucket({ title, items, structureBySymbol = {} }) {
  const columns = [
    { key: "symbol", label: "Symbol", value: (item) => item.symbol || "" },
    { key: "structure", label: "BOS", value: (item) => structureBySymbol[String(item.symbol || "").toUpperCase()] || "Unknown" },
    { key: "side", label: "Side", value: (item) => item.side || "" },
    { key: "status", label: "Status", value: (item) => item.status || "" },
    { key: "quantity", label: "Qty", value: (item) => Number(item.quantity) },
    { key: "order", label: "Order", value: (item) => item.order_type || "" },
    { key: "time", label: "Time", value: (item) => Date.parse(item.updated_at || item.created_at || "") || 0 },
  ];
  const { sortedItems, sort, toggleSort } = useSortedItems(items, columns, { key: "time", direction: "desc" });

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
              {columns.map((column) => (
                <AppSortHeader key={column.key} column={column} sort={sort} onSort={toggleSort} />
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedItems.length ? sortedItems.map((item, index) => (
              <tr key={orderRowKey(item, index)}>
                <td data-label="Symbol"><strong>{item.symbol || "-"}</strong></td>
                <td data-label="BOS">
                  <span className={`structure-pill ${appStructureClass(structureBySymbol[String(item.symbol || "").toUpperCase()])}`}>
                    {appStructureLabel(structureBySymbol[String(item.symbol || "").toUpperCase()])}
                  </span>
                </td>
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
                <td colSpan="7" className="alert-log-empty-cell">No {title.toLowerCase()} orders found</td>
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

function AppSortHeader({ column, sort, onSort }) {
  const active = sort.key === column.key;
  const direction = active ? sort.direction : "";
  return (
    <th className={column.className || ""}>
      <button
        type="button"
        className={`sort-header-button ${active ? "active" : ""}`}
        onClick={() => onSort(column.key)}
        aria-label={`Sort by ${column.label}${active ? ` ${direction === "asc" ? "descending" : "ascending"}` : ""}`}
      >
        {column.label}
        <span aria-hidden="true">{active ? (direction === "asc" ? "▲" : "▼") : "↕"}</span>
      </button>
    </th>
  );
}

function useSortedItems(items, columns, defaultSort) {
  const [sort, setSort] = useState(defaultSort || { key: columns[0]?.key || "", direction: "asc" });
  const sortedItems = useMemo(() => {
    const column = columns.find((item) => item.key === sort.key) || columns[0];
    if (!column) return items;
    const direction = sort.direction === "desc" ? -1 : 1;
    return [...items].sort((left, right) => compareSortValues(column.value(left), column.value(right)) * direction);
  }, [columns, items, sort]);

  function toggleSort(key) {
    setSort((current) => ({
      key,
      direction: current.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  }

  return { sortedItems, sort, toggleSort };
}

function compareSortValues(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  return String(left ?? "").localeCompare(String(right ?? ""), undefined, { numeric: true, sensitivity: "base" });
}

function appStructureLabel(value) {
  const text = String(value || "Unknown");
  if (text === "Bullish BOS") return "Bull BOS";
  if (text === "Bearish BOS") return "Bear BOS";
  return text;
}

function appStructureClass(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("bullish")) return "bullish";
  if (text.includes("bearish")) return "bearish";
  if (text.includes("chop") || text.includes("intact")) return "chop";
  return "unknown";
}

function AlertLogPage({ alertLog, onClear, onSelectSymbol, structureBySymbol }) {
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
        structureBySymbol={structureBySymbol}
      />
    </section>
  );
}

function AlertLogTable({ items, onSelectSymbol, structureBySymbol = {} }) {
  const columns = [
    { key: "symbol", label: "Symbol", value: (item) => item.symbol || "" },
    { key: "structure", label: "BOS", value: (item) => structureBySymbol[String(item.symbol || "").toUpperCase()] || "Unknown" },
    { key: "type", label: "Type", value: (item) => item.kind || "notification" },
    { key: "notification", label: "Notification", value: (item) => item.title || item.reason || "" },
    { key: "time", label: "Time", value: (item) => Date.parse(item.alertedAt || item.createdAt || "") || 0 },
  ];
  const { sortedItems, sort, toggleSort } = useSortedItems(items, columns, { key: "time", direction: "desc" });

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
              {columns.map((column) => (
                <AppSortHeader key={column.key} column={column} sort={sort} onSort={toggleSort} />
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedItems.length ? sortedItems.map((item) => (
              <tr key={item.id}>
                <td data-label="Symbol">
                  {item.symbol ? (
                    <button type="button" onClick={() => onSelectSymbol(item.symbol)}>{item.symbol}</button>
                  ) : "-"}
                </td>
                <td data-label="BOS">
                  <span className={`structure-pill ${appStructureClass(structureBySymbol[String(item.symbol || "").toUpperCase()])}`}>
                    {appStructureLabel(structureBySymbol[String(item.symbol || "").toUpperCase()])}
                  </span>
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
                <td colSpan="5" className="alert-log-empty-cell">No notifications saved yet</td>
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
  onVisibleTabChange,
  riskSettings,
  strategyState,
  visibleTabs,
}) {
  return (
    <div className="settings-menu-content">
      <div className="settings-menu-heading">
        <div>
          <h2>Settings</h2>
          <p className="muted">
            MTF table alerts automatic · {autoTrade.enabled ? "Auto Long on" : "Auto Long off"} · {autoLongEnabledCount} auto strategies
          </p>
        </div>
      </div>
      <RiskSettingsPanel
        disabled={disabled}
        onApply={onApplyRisk}
        onChange={onRiskChange}
        riskSettings={riskSettings}
      />
      <VisibleTabsPanel
        disabled={disabled}
        onChange={onVisibleTabChange}
        visibleTabs={visibleTabs}
      />
      <AutoTradePanel
        accountId={accountId}
        autoTrade={autoTrade}
        disabled={disabled}
        onChange={onAutoTradeChange}
      />
      <AlertStrategies />
    </div>
  );
}

function VisibleTabsPanel({ disabled, onChange, visibleTabs }) {
  return (
    <section className="visible-tabs-panel" aria-label="Visible tabs">
      <div className="visible-tabs-heading">
        <div>
          <h3>Visible tabs</h3>
          <p>Only enabled tab data refreshes in the background.</p>
        </div>
        <em>{APP_TABS.filter((tab) => visibleTabs?.[tab.id] !== false).length} on</em>
      </div>
      <div className="visible-tabs-grid">
        {APP_TABS.map((tab) => (
          <label key={tab.id} className={`visible-tab-toggle ${visibleTabs?.[tab.id] !== false ? "enabled" : ""}`}>
            <input
              type="checkbox"
              checked={visibleTabs?.[tab.id] !== false}
              disabled={disabled}
              onChange={(event) => onChange(tab.id, event.target.checked)}
            />
            <span>
              <strong>{tab.label}</strong>
              <small>{tabDataLabel(tab.data)}</small>
            </span>
          </label>
        ))}
      </div>
    </section>
  );
}

function tabDataLabel(data) {
  if (data === "watchlists") return "Watchlist prices";
  if (data === "sectors") return "Sector movers";
  if (data === "insiders") return "Insider feed";
  if (data === "alerts") return "Alert history";
  return "App view";
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

function ScannerWatchlistPicker({ onSelectAll, onToggle, selectedIds, watchlists }) {
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
  allCount,
  isAllWatchlistsTab,
  onAddSymbols,
  onAddTab,
  onClearWatchlist,
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
        <span className={`watchlist-tab ${isAllWatchlistsTab ? "active" : ""}`}>
          <button
            type="button"
            onClick={() => onSwitchTab(ALL_WATCHLISTS_TAB_ID)}
            role="tab"
            aria-selected={isAllWatchlistsTab}
          >
            All
            <b>{allCount}</b>
          </button>
        </span>
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
      {isAllWatchlistsTab ? null : (
      <div className="daily-list-editor">
        <label className="watchlist-auto-trade-toggle">
          <input
            type="checkbox"
            checked={selectedWatchlist?.autoTradeEnabled !== false}
            disabled={!selectedWatchlist || loading}
            onChange={(event) => onToggleAutoTrade(selectedWatchlist.id, event.target.checked)}
          />
          <span>{selectedWatchlist?.autoTradeEnabled === false ? "Auto-trade OFF" : "Auto-trade ON"}</span>
        </label>
        <form onSubmit={onAddSymbols}>
          <input
            aria-label={`Add symbols to ${selectedWatchlist?.name || "watchlist"}`}
            placeholder="Add ticker"
            value={symbolInput}
            onChange={(event) => onSymbolInput(activeTab, event.target.value)}
          />
          <button type="submit" disabled={loading}>Add</button>
          <button
            type="button"
            className="watchlist-clear"
            onClick={() => onClearWatchlist(selectedWatchlist?.id)}
            disabled={loading || !selectedWatchlist?.symbols?.length}
          >
            Clear all
          </button>
        </form>
      </div>
      )}
    </section>
  );
}
