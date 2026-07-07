import { useEffect, useMemo, useRef, useState } from "react";

import { Header } from "./components/Header";
import { HiddenLegacyPanels } from "./components/HiddenLegacyPanels";
import { MtfTable, PriceBucket } from "./components/PriceTables";
import { getJson, postJson } from "./lib/api";
import { ALERT_STRATEGIES, filterQuotesByStrategy, loadStrategyState, saveStrategyState, strategyIdForMatch } from "./lib/alertStrategies";
import { cloudStatus, confirmedMtfQuotes, displayMtfLabel, flattenAccounts, formatPrice, isMarketRefreshWindow, marginTradingAccountId, matchEntryPrice, notificationMatchText, mtfSignature, preferredAccountId } from "./lib/market";
import { disableNotifications, enableNotifications, loadNotificationState, setAppBadgeCount, showDeviceNotification, syncNotificationPreferences } from "./lib/notifications";

const PASSIVE_MARKET_REFRESH_INTERVAL_MS = 2 * 60 * 1000;
const WATCHLIST_SYNC_INTERVAL_MS = 2 * 60 * 1000;
const MAX_NOTIFICATIONS = 20;
const MAX_ALERT_LOG = 500;
const DAILY_SYMBOLS_KEY = "dhanam-daily-symbols";
const WATCHLISTS_KEY = "dhanam-watchlists";
const RISK_SETTINGS_KEY = "dhanam-risk-settings";
const ALERT_LOG_KEY = "dhanam-alert-log";
const AUTO_TRADE_KEY = "dhanam-auto-trade";
const AUTO_TRADE_EXECUTIONS_KEY = "dhanam-auto-trade-executions";
const MAX_AUTO_TRADE_EXECUTIONS = 500;
const OG_WATCHLIST_ID = "og";
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
    });
  }
  if (!normalized.some((item) => item.id === OG_WATCHLIST_ID)) {
    normalized.unshift({ id: OG_WATCHLIST_ID, name: "OG list", symbols: OG_SYMBOLS, locked: true });
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

function mtfRowSignature(quote) {
  const labels = (quote.mtf_matches || []).map((match) => `${match.label}:${matchEntryPrice(match) ?? ""}`).sort().join("|");
  return `${quote.symbol}:${labels}`;
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

function quotesWithMatchStatus(quotes, status) {
  return quotes
    .map((quote) => ({
      ...quote,
      mtf_matches: (quote.mtf_matches || []).filter((match) => (match.status || "confirmed") === status),
    }))
    .filter((quote) => quote.mtf_matches.length);
}

function quotesWithTradeAction(quotes, action) {
  return quotes
    .map((quote) => ({
      ...quote,
      mtf_matches: (quote.mtf_matches || []).filter((match) => match.trade_action === action),
    }))
    .filter((quote) => quote.mtf_matches.length);
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
  return Object.fromEntries(ALERT_STRATEGIES.map((strategy) => [strategy.id, false]));
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
    return Array.isArray(saved) ? saved.filter((item) => item?.symbol && item?.alertedAt) : [];
  } catch {
    return [];
  }
}

function saveAlertLog(items) {
  window.localStorage.setItem(ALERT_LOG_KEY, JSON.stringify(items.slice(0, MAX_ALERT_LOG)));
}

function alertLogEntries(tab, quotes, watchlists, riskSettings) {
  const alertedAt = new Date().toISOString();
  const watchlist = watchlists.find((item) => item.id === tab);
  return quotes.flatMap((quote) => (
    (quote.mtf_matches || []).map((match) => {
      const outcomePlan = alertOutcomePlan(match, quote.price, riskSettings);
      return {
        id: `${alertedAt}-${tab}-${quote.symbol}-${match.label}`,
        alertedAt,
        candleTime: match.candle_time || "",
        symbol: quote.symbol,
        watchlistId: tab,
        watchlistName: watchlist?.name || tab,
        action: match.trade_action || "",
        label: match.label || "",
        reason: displayMtfLabel(match),
        entryPrice: matchEntryPrice(match),
        status: match.status || "confirmed",
        price: quote.price ?? null,
        lastPrice: quote.price ?? null,
        riskPlan: match.risk_plan || null,
        stopPrice: outcomePlan?.stop ?? null,
        targetPrice: outcomePlan?.target ?? null,
        outcome: "",
        outcomeAt: "",
        trend: match.trend || "",
      };
    })
  ));
}

function autoTradeKey(tab, symbol, match) {
  return `${tab}:${symbol}:${match.label || displayMtfLabel(match)}:${match.candle_time || ""}`;
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

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

function alertOutcomePlan(match, fallbackPrice, riskSettings) {
  const action = match.trade_action;
  const entry = Number(matchEntryPrice(match) ?? fallbackPrice);
  if (!Number.isFinite(entry) || !["Long", "Short"].includes(action)) return null;
  const riskPlan = match.risk_plan || null;
  const cloudLow = Number(match.low ?? match.cloud_low);
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

export default function App() {
  const [watchlists, setWatchlists] = useState(loadWatchlists);
  const [status, setStatus] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useState(null);
  const [quotesByTab, setQuotesByTab] = useState(() => initialTabState(loadWatchlists(), []));
  const [updatedTextByTab, setUpdatedTextByTab] = useState(() => initialTabState(loadWatchlists(), "Webull polling stopped"));
  const [alert, setAlert] = useState("");
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
  const [activePage, setActivePage] = useState(() => window.location.hash === "#alerts" ? "alerts" : "home");
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
  });
  const passiveMarketTimer = useRef(null);
  const watchlistSyncTimer = useRef(null);
  const lastMtfSignature = useRef(initialTabState(loadWatchlists(), null));
  const lastMtfRows = useRef(initialTabState(loadWatchlists(), {}));
  const strategyStateRef = useRef(strategyState);
  const riskSettingsRef = useRef(riskSettings);
  const autoTradeRef = useRef(autoTrade);
  const autoTradeExecutionsRef = useRef(new Set(loadAutoTradeExecutions()));
  const selectedAccountIdRef = useRef(selectedAccountId);
  const accountsRef = useRef(accounts);
  const watchlistTabRef = useRef(watchlistTab);
  const watchlistsRef = useRef(watchlists);
  const activeWatchlist = watchlists.find((item) => item.id === watchlistTab) || watchlists[0];
  const quotes = quotesByTab[watchlistTab] || [];
  const updatedText = updatedTextByTab[watchlistTab] || "";
  const pageLoading = loading.shell || loading.watchlists || loading.prices || loading.notifications;
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
  const waitingMtfs = useMemo(() => quotesWithMatchStatus(allMtfQuotes, "waiting"), [allMtfQuotes]);
  const unreadNotificationCount = useMemo(() => notifications.filter((item) => !item.read).length, [notifications]);

  async function refreshShell() {
    setLoadingKey("shell", true);
    try {
      const nextStatus = await getJson("/api/status");
      setStatus(nextStatus);
      if (!nextStatus.configured) {
        setAlert("Add WEBULL_APP_KEY and WEBULL_APP_SECRET to .env, then restart the server.");
      } else {
        setAlert("");
      }

      const accountResponse = await getJson("/api/accounts");
      if (!accountResponse.ok) {
        setAlert(accountResponse.error || `Webull returned ${accountResponse.status_code}`);
      }
      const nextAccounts = flattenAccounts(accountResponse.data);
      setAccounts(nextAccounts);
      setSelectedAccountId((current) => preferredAccountId(nextAccounts, current));
    } catch (error) {
      setAlert(error.message);
    } finally {
      setLoadingKey("shell", false);
    }
  }

  async function refreshWatchlists({ showLoading = true } = {}) {
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

  async function loadLivePrices({ manual = false, showLoading = true } = {}) {
    if (!manual && !isMarketRefreshWindow()) {
      setUpdatedTextForTab(watchlistTabRef.current, "Auto-refresh paused until premarket open");
      return;
    }

    setLiveAlert("");
    if (showLoading) setLoadingKey("prices", true);
    try {
      const activeTab = watchlistTabRef.current;
      const selectedWatchlist = watchlistsRef.current.find((item) => item.id === activeTab);
      await refreshWatchlistPrices(selectedWatchlist);
    } catch (error) {
      setLiveAlert(error.message);
    } finally {
      if (showLoading) setLoadingKey("prices", false);
    }
  }

  async function refreshAllPrices({ showLoading = true } = {}) {
    setLiveAlert("");
    if (showLoading) setLoadingKey("prices", true);
    try {
      const lists = watchlistsRef.current;
      for (const watchlist of lists) {
        await refreshWatchlistPrices(watchlist);
      }
    } catch (error) {
      setLiveAlert(error.message);
    } finally {
      if (showLoading) setLoadingKey("prices", false);
    }
  }

  async function refreshWatchlistPrices(watchlist) {
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
    const nextQuotes = payload.quotes || [];
    const updatedAt = new Date().toLocaleTimeString();
    setQuotesForTab(watchlist.id, nextQuotes);
    updateAlertOutcomes(nextQuotes);
    setUpdatedTextForTab(watchlist.id, `Updated ${updatedAt} from ${payload.source || "webull"}`);
    notifyMtfUpdate(watchlist.id, filterQuotesByStrategy(confirmedMtfQuotes(nextQuotes), strategyStateRef.current));

    if (payload.errors?.length) {
      setLiveAlert(`Some data failed: ${payload.errors.map((item) => item.source).join(", ")}`);
    }
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

    appendAlertLog(alertLogEntries(tab, nextMtfs, watchlistsRef.current, riskSettingsRef.current));
    const notification = mtfNotificationDetails(nextMtfs);
    addNotification({
      title: notification.title,
      message: notification.body,
      kind: "changed",
    });
    showMtfDeviceNotification(notification);
    if (changed) autoBuyLongAlerts(tab, freshQuotes);
  }

  function appendAlertLog(entries) {
    if (!entries.length) return;
    setAlertLog((current) => {
      const seen = new Set(current.map((item) => `${item.symbol}:${item.label || item.reason}:${item.candleTime}:${item.watchlistId}`));
      const freshEntries = entries.filter((item) => !seen.has(`${item.symbol}:${item.label || item.reason}:${item.candleTime}:${item.watchlistId}`));
      if (!freshEntries.length) return current;
      const next = [...freshEntries, ...current].slice(0, MAX_ALERT_LOG);
      saveAlertLog(next);
      return next;
    });
  }

  function clearAlertLog() {
    setAlertLog([]);
    saveAlertLog([]);
  }

  function updateAlertOutcomes(nextQuotes) {
    const prices = Object.fromEntries(nextQuotes.map((quote) => [quote.symbol, Number(quote.price)]));
    setAlertLog((current) => {
      let changed = false;
      const next = current.map((item) => {
        if (item.outcome || !["Long", "Short"].includes(item.action)) return item;
        const price = prices[item.symbol];
        const stop = Number(item.stopPrice ?? item.riskPlan?.stop);
        const target = Number(item.targetPrice);
        if (!Number.isFinite(price) || !Number.isFinite(stop) || !Number.isFinite(target)) return item;
        const hitTarget = item.action === "Long" ? price >= target : price <= target;
        const hitStop = item.action === "Long" ? price <= stop : price >= stop;
        if (!hitTarget && !hitStop) {
          if (item.lastPrice === price) return item;
          changed = true;
          return { ...item, lastPrice: price };
        }
        changed = true;
        return {
          ...item,
          outcome: hitTarget ? "Target" : "SL",
          outcomeAt: new Date().toISOString(),
          outcomePrice: price,
          lastPrice: price,
        };
      });
      if (changed) saveAlertLog(next);
      return changed ? next : current;
    });
  }

  function navigatePage(page) {
    setActivePage(page);
    window.history.replaceState(null, "", page === "alerts" ? "#alerts" : window.location.pathname);
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
    if (quote.mtf_matches?.some((match) => match.status === "waiting")) {
      setLiveAlert(`${symbol} is still waiting for the candle close.`);
      return;
    }
    if (quote.mtf_matches?.some((match) => match.trade_action === "Short")) {
      setLiveAlert(`${symbol} is a short signal. Short order placement is not wired yet.`);
      return;
    }
    const confirmed = window.confirm(`Buy 1 share of ${symbol} with a market order in account ${accountId}?`);
    if (!confirmed) return;

    setBuyState((current) => ({ ...current, [symbol]: { status: "loading" } }));
    try {
      const payload = await postJson("/api/trade/buy", { account_id: accountId, symbol });
      if (!payload.ok) {
        throw new Error(payload.error || payload.preview?.error || payload.place?.error || `Webull rejected ${symbol} buy order.`);
      }
      setBuyState((current) => ({ ...current, [symbol]: { status: "ok" } }));
      setLiveAlert(`Submitted buy order for 1 share of ${symbol}.`);
    } catch (error) {
      setBuyState((current) => ({ ...current, [symbol]: { status: "error" } }));
      setLiveAlert(error.message);
    }
  }

  async function autoBuyLongAlerts(tab, quotes) {
    if (!autoTradeRef.current.enabled) return;
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
    const nextWatchlist = { id, name, symbols: [], locked: false };
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
    setWatchlistTab((current) => next.some((item) => item.id === current) ? current : OG_WATCHLIST_ID);
  }

  async function refreshAppMarketData({ showLoading = true } = {}) {
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

  function pauseBackgroundRefresh() {
    if (passiveMarketTimer.current) clearInterval(passiveMarketTimer.current);
    if (watchlistSyncTimer.current) clearInterval(watchlistSyncTimer.current);
    passiveMarketTimer.current = null;
    watchlistSyncTimer.current = null;

    return () => {
      if (!watchlistSyncTimer.current) {
        watchlistSyncTimer.current = setInterval(() => refreshWatchlists({ showLoading: false }), WATCHLIST_SYNC_INTERVAL_MS);
      }
      if (!passiveMarketTimer.current) {
        passiveMarketTimer.current = setInterval(() => {
          if (isMarketRefreshWindow()) refreshAppMarketData({ showLoading: false });
        }, PASSIVE_MARKET_REFRESH_INTERVAL_MS);
      }
    };
  }

  useEffect(() => {
    refreshShell();
    refreshAppMarketData();
    passiveMarketTimer.current = setInterval(() => {
      if (isMarketRefreshWindow()) refreshAppMarketData({ showLoading: false });
    }, PASSIVE_MARKET_REFRESH_INTERVAL_MS);
    watchlistSyncTimer.current = setInterval(() => refreshWatchlists({ showLoading: false }), WATCHLIST_SYNC_INTERVAL_MS);
    loadNotificationState()
      .then(setNotificationState)
      .catch(() => {
        setNotificationState((current) => ({ ...current, supported: false }));
      });
    return () => {
      if (passiveMarketTimer.current) clearInterval(passiveMarketTimer.current);
      if (watchlistSyncTimer.current) clearInterval(watchlistSyncTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return undefined;
    function handleServiceWorkerMessage(event) {
      if (event.data?.type !== "MTF_PUSH_UPDATE") return;
      const targetSymbol = event.data.payload?.targetSymbol;
      if (targetSymbol) focusMtfSymbol(targetSymbol);
      refreshAppMarketData({ showLoading: false });
    }

    navigator.serviceWorker.addEventListener("message", handleServiceWorkerMessage);
    return () => navigator.serviceWorker.removeEventListener("message", handleServiceWorkerMessage);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const symbol = params.get("mtf");
    if (symbol) focusMtfSymbol(symbol);
  }, []);

  useEffect(() => {
    if (!focusedMtfSymbol || !allMtfs.some((quote) => quote.symbol === focusedMtfSymbol)) return;
    window.requestAnimationFrame(() => {
      document.getElementById(`mtf-row-${focusedMtfSymbol}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [allMtfs, focusedMtfSymbol]);

  useEffect(() => {
    const canBadge = notificationState.appEnabled && notificationState.permission === "granted";
    setAppBadgeCount(canBadge ? unreadNotificationCount : 0).catch(() => {});
  }, [notificationState.appEnabled, notificationState.permission, unreadNotificationCount]);

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
    watchlistTabRef.current = watchlistTab;
  }, [watchlistTab]);

  useEffect(() => {
    watchlistsRef.current = watchlists;
  }, [watchlists]);

  useEffect(() => {
    if (!notificationState.appEnabled) return;
    syncNotificationPreferences(strategyState).catch(() => {});
  }, [notificationState.appEnabled, strategyState]);

  return (
    <>
      <Header
        status={status}
        accounts={accounts}
        selectedAccountId={selectedAccountId}
        loading={loading}
        pageLoading={pageLoading}
        onRefresh={refreshShell}
        onSelectAccount={(accountId) => setSelectedAccountId(preferredAccountId(accounts, accountId))}
        notificationState={notificationState}
        onEnableNotifications={enableAppNotifications}
        onDisableNotifications={disableAppNotifications}
        notifications={notifications}
        onMarkNotificationsRead={markNotificationsRead}
        activePage={activePage}
        alertLogCount={alertLog.length}
        onNavigate={navigatePage}
        strategyState={strategyState}
        onToggleStrategy={toggleStrategy}
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
        {alert ? <div className="alert app-alert">{alert}</div> : null}

        {activePage === "alerts" ? (
          <AlertLogPage
            alertLog={alertLog}
            onClear={clearAlertLog}
            onSelectSymbol={(symbol) => {
              focusMtfSymbol(symbol);
              navigatePage("home");
            }}
          />
        ) : (
          <div className="homepage-market-grid">
            <section className="live-prices-panel">
              <WatchlistTabs
                activeTab={watchlistTab}
                onAddSymbols={addSymbolsToActiveWatchlist}
                onAddTab={addWatchlist}
                onDeleteTab={deleteWatchlist}
                onRefreshAll={refreshAllPrices}
                loading={loading.watchlists || loading.prices}
                onSymbolInput={(value) => setSymbolInputs((current) => ({ ...current, [watchlistTab]: value }))}
                onSwitchTab={switchWatchlistTab}
                selectedWatchlist={activeWatchlist}
                symbolInput={symbolInputs[watchlistTab] || ""}
                watchlists={watchlists}
              />
              <RiskSettingsPanel
                disabled={loading.prices}
                onApply={refreshAllPrices}
                riskSettings={riskSettings}
                onChange={updateRiskSettings}
              />
              <AutoTradePanel
                accountId={tradingAccountId}
                autoTrade={autoTrade}
                disabled={loading.prices}
                onChange={updateAutoTradeSettings}
              />
              <div className="section-heading">
                <div>
                  <h2>{activeWatchlist?.name || "Watchlist"}</h2>
                  <p className="muted">Live Webull prices with clock-aligned EMA levels.</p>
                </div>
                <div className="live-price-actions">
                  <button type="button" onClick={() => loadLivePrices({ manual: true })} disabled={loading.prices}>
                    Refresh Prices
                  </button>
                </div>
              </div>

              {liveAlert ? <div className="alert">{liveAlert}</div> : null}

              <div className="active-watchlist-tables">
                <div className="trend-price-grid">
                  <PriceBucket title="Bullish" quotes={trendBuckets.bullish} kind="bullish" onRemoveSymbol={(symbol) => removeSymbolFromWatchlist(symbol)} />
                  <PriceBucket title="Bearish" quotes={trendBuckets.bearish} kind="bearish" onRemoveSymbol={(symbol) => removeSymbolFromWatchlist(symbol)} />
                  <PriceBucket title="Chop" quotes={trendBuckets.chop} kind="chop" onRemoveSymbol={(symbol) => removeSymbolFromWatchlist(symbol)} />
                </div>
                <p className="muted">{updatedText}</p>
              </div>
            </section>
            <aside className="global-mtf-panel" aria-label="MTFs from all tabs">
              <MtfTable
                quotes={longMtfs}
                title="Long"
                showWatchlist
                buyState={buyState}
                emptyText="None"
                focusedSymbol={focusedMtfSymbol}
                onBuy={buyMtfQuote}
                onDismissNew={(quote) => dismissNewMtfRow(quote.watchlist_id, quote.symbol)}
                showSignalTags={false}
              />
              <MtfTable
                quotes={shortMtfs}
                title="Short"
                showWatchlist
                buyState={buyState}
                emptyText="None"
                focusedSymbol={focusedMtfSymbol}
                onBuy={buyMtfQuote}
                onDismissNew={(quote) => dismissNewMtfRow(quote.watchlist_id, quote.symbol)}
                showSignalTags={false}
              />
              <MtfTable
                quotes={waitingMtfs}
                title="Wait"
                showWatchlist
                emptyText="None"
                focusedSymbol={focusedMtfSymbol}
              />
            </aside>
          </div>
        )}
        <HiddenLegacyPanels />
      </main>
    </>
  );
}

function AlertLogPage({ alertLog, onClear, onSelectSymbol }) {
  const [query, setQuery] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState("all");
  const searched = useMemo(() => {
    const needle = query.trim().toUpperCase();
    if (!needle) return alertLog;
    return alertLog.filter((item) => (
      item.symbol.includes(needle)
      || item.reason.toUpperCase().includes(needle)
      || item.action.toUpperCase().includes(needle)
      || item.watchlistName.toUpperCase().includes(needle)
      || String(item.outcome || "").toUpperCase().includes(needle)
    ));
  }, [alertLog, query]);
  const outcomeCounts = useMemo(() => ({
    all: searched.length,
    open: searched.filter((item) => !item.outcome).length,
    target: searched.filter((item) => item.outcome === "Target").length,
    sl: searched.filter((item) => item.outcome === "SL").length,
  }), [searched]);
  const filtered = useMemo(() => {
    if (outcomeFilter === "open") return searched.filter((item) => !item.outcome);
    if (outcomeFilter === "target") return searched.filter((item) => item.outcome === "Target");
    if (outcomeFilter === "sl") return searched.filter((item) => item.outcome === "SL");
    return searched;
  }, [outcomeFilter, searched]);
  const longAlerts = useMemo(() => filtered.filter((item) => item.action === "Long"), [filtered]);
  const shortAlerts = useMemo(() => filtered.filter((item) => item.action === "Short"), [filtered]);

  return (
    <section className="alert-log-page">
      <div className="alert-log-header">
        <div>
          <h2>Alert Log</h2>
          <p className="muted">Search past MTF alerts by stock, setup, action, or list.</p>
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
        <strong>{filtered.length}</strong>
      </div>
      <div className="alert-log-tabs" role="tablist" aria-label="Alert outcome filter">
        <button
          type="button"
          className={outcomeFilter === "all" ? "active" : ""}
          onClick={() => setOutcomeFilter("all")}
          role="tab"
          aria-selected={outcomeFilter === "all"}
        >
          All <span>{outcomeCounts.all}</span>
        </button>
        <button
          type="button"
          className={outcomeFilter === "open" ? "active open" : "open"}
          onClick={() => setOutcomeFilter("open")}
          role="tab"
          aria-selected={outcomeFilter === "open"}
        >
          Open <span>{outcomeCounts.open}</span>
        </button>
        <button
          type="button"
          className={outcomeFilter === "target" ? "active target" : "target"}
          onClick={() => setOutcomeFilter("target")}
          role="tab"
          aria-selected={outcomeFilter === "target"}
        >
          Target <span>{outcomeCounts.target}</span>
        </button>
        <button
          type="button"
          className={outcomeFilter === "sl" ? "active sl" : "sl"}
          onClick={() => setOutcomeFilter("sl")}
          role="tab"
          aria-selected={outcomeFilter === "sl"}
        >
          SL <span>{outcomeCounts.sl}</span>
        </button>
      </div>
      <div className="alert-log-tables">
        <AlertLogTable title="Long" items={longAlerts} onSelectSymbol={onSelectSymbol} />
        <AlertLogTable title="Short" items={shortAlerts} onSelectSymbol={onSelectSymbol} />
      </div>
    </section>
  );
}

function AlertLogTable({ title, items, onSelectSymbol }) {
  return (
    <section className={`alert-log-table-card ${title.toLowerCase()}`}>
      <div className="alert-log-table-heading">
        <h3>{title}</h3>
        <span>{items.length}</span>
        <em>R:R 1:1</em>
      </div>
      <div className="alert-log-table-wrap">
        <table className="alert-log-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Entry</th>
              <th>Exit</th>
              <th>Alert</th>
              <th>Timestamp</th>
            </tr>
          </thead>
          <tbody>
            {items.length ? items.map((item) => (
              <tr key={item.id} className={alertOutcomeRowClass(item)}>
                <td data-label="Symbol">
                  <button type="button" onClick={() => onSelectSymbol(item.symbol)}>{item.symbol}</button>
                </td>
                <td data-label="Entry">{item.entryPrice != null ? formatPrice(item.entryPrice) : "-"}</td>
                <td data-label="Exit">
                  <div className="alert-log-exit">
                    {item.outcome ? (
                      <>
                        <span>{alertExitPrice(item)}</span>
                        <em className={`outcome-tag ${String(item.outcome).toLowerCase()}`}>{item.outcome}</em>
                      </>
                    ) : (
                      <>
                        <span>{alertLastPrice(item)}</span>
                        {item.targetPrice != null ? <small>Target {formatPrice(item.targetPrice)}</small> : null}
                        {item.stopPrice != null ? <small>SL {formatPrice(item.stopPrice)}</small> : null}
                      </>
                    )}
                  </div>
                </td>
                <td data-label="Alert">
                  <div className="alert-log-alert">
                    <strong>{item.reason}</strong>
                    <span>{item.watchlistName}</span>
                  </div>
                </td>
                <td data-label="Timestamp">
                  <div className="alert-log-time">
                    <time dateTime={item.alertedAt}>{formatDateTime(item.alertedAt)}</time>
                    {item.outcomeAt ? <small>Hit {formatDateTime(item.outcomeAt)}</small> : null}
                  </div>
                </td>
              </tr>
            )) : (
              <tr>
                <td colSpan="5" className="alert-log-empty-cell">No {title.toLowerCase()} alerts found</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function alertExitPrice(item) {
  const fallback = item.outcome === "Target" ? item.targetPrice : item.stopPrice;
  const exitPrice = item.outcomePrice ?? fallback;
  return exitPrice != null ? formatPrice(exitPrice) : "-";
}

function alertLastPrice(item) {
  const lastPrice = item.lastPrice ?? item.price;
  return lastPrice != null ? `Last ${formatPrice(lastPrice)}` : "-";
}

function alertOutcomeRowClass(item) {
  const outcome = String(item.outcome || "").toLowerCase();
  return outcome === "target" || outcome === "sl" ? `hit-${outcome}` : "";
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

  const enabledCount = ALERT_STRATEGIES.filter((strategy) => autoTrade.strategies?.[strategy.id]).length;

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
        {ALERT_STRATEGIES.map((strategy) => (
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

function WatchlistTabs({
  activeTab,
  onAddSymbols,
  onAddTab,
  onDeleteTab,
  onRefreshAll,
  loading,
  onSwitchTab,
  onSymbolInput,
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
        <button
          type="button"
          className="watchlist-refresh-all"
          onClick={onRefreshAll}
          disabled={loading}
        >
          Refresh All
        </button>
      </div>
      <div className="daily-list-editor">
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
