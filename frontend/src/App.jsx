import { useEffect, useMemo, useRef, useState } from "react";

import { Header } from "./components/Header";
import { HiddenLegacyPanels } from "./components/HiddenLegacyPanels";
import { MtfTable, PriceBucket } from "./components/PriceTables";
import { getJson, postJson } from "./lib/api";
import { filterQuotesByStrategy, loadStrategyState, saveStrategyState } from "./lib/alertStrategies";
import { cloudStatus, confirmedMtfQuotes, describeMtfMatches, findAccountId, flattenAccounts, isMarketRefreshWindow, mtfSignature } from "./lib/market";
import { disableNotifications, enableNotifications, loadNotificationState, setAppBadgeCount, showDeviceNotification, syncNotificationPreferences } from "./lib/notifications";

const MARKET_REFRESH_INTERVAL_MS = 15000;
const WATCHLIST_SYNC_INTERVAL_MS = 30000;
const MAX_NOTIFICATIONS = 20;
const DAILY_SYMBOLS_KEY = "dhanam-daily-symbols";
const WATCHLISTS_KEY = "dhanam-watchlists";
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
  const labels = (quote.mtf_matches || []).map((match) => match.label).sort().join("|");
  return `${quote.symbol}:${labels}`;
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
  const [liveRefreshActive, setLiveRefreshActive] = useState(false);
  const [notificationState, setNotificationState] = useState({
    supported: false,
    permission: "default",
    webPushConfigured: false,
    subscribed: false,
    appEnabled: true,
  });
  const [notifications, setNotifications] = useState([]);
  const [strategyState, setStrategyState] = useState(loadStrategyState);
  const [watchlistTab, setWatchlistTab] = useState(OG_WATCHLIST_ID);
  const [symbolInputs, setSymbolInputs] = useState({});
  const [newMtfRows, setNewMtfRows] = useState({});
  const [loading, setLoading] = useState({
    shell: false,
    watchlists: false,
    prices: false,
    notifications: false,
  });
  const liveTimer = useRef(null);
  const watchlistSyncTimer = useRef(null);
  const lastMtfSignature = useRef(initialTabState(loadWatchlists(), null));
  const lastMtfRows = useRef(initialTabState(loadWatchlists(), {}));
  const lastFocusRefreshAt = useRef(0);
  const strategyStateRef = useRef(strategyState);
  const watchlistTabRef = useRef(watchlistTab);
  const watchlistsRef = useRef(watchlists);
  const activeWatchlist = watchlists.find((item) => item.id === watchlistTab) || watchlists[0];
  const quotes = quotesByTab[watchlistTab] || [];
  const updatedText = updatedTextByTab[watchlistTab] || "";
  const pageLoading = loading.shell || loading.watchlists || loading.prices || loading.notifications;

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
  const allMtfs = useMemo(() => {
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
      setSelectedAccountId((current) => current || findAccountId(nextAccounts));
    } catch (error) {
      setAlert(error.message);
    } finally {
      setLoadingKey("shell", false);
    }
  }

  async function refreshWatchlists() {
    setLoadingKey("watchlists", true);
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
      setLoadingKey("watchlists", false);
    }
  }

  async function loadLivePrices({ manual = false } = {}) {
    if (!manual && !isMarketRefreshWindow()) {
      setUpdatedTextForTab(watchlistTabRef.current, "Auto-refresh paused until premarket open");
      return;
    }

    setLiveAlert("");
    setLoadingKey("prices", true);
    try {
      const activeTab = watchlistTabRef.current;
      const selectedWatchlist = watchlistsRef.current.find((item) => item.id === activeTab);
      await refreshWatchlistPrices(selectedWatchlist);
    } catch (error) {
      setLiveAlert(error.message);
    } finally {
      setLoadingKey("prices", false);
    }
  }

  async function refreshAllPrices() {
    setLiveAlert("");
    setLoadingKey("prices", true);
    try {
      const lists = watchlistsRef.current;
      for (const watchlist of lists) {
        await refreshWatchlistPrices(watchlist);
      }
    } catch (error) {
      setLiveAlert(error.message);
    } finally {
      setLoadingKey("prices", false);
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
    const query = `?symbols=${encodeURIComponent(selectedSymbols.join(","))}`;
    const payload = await getJson(`/api/webull/live-prices${query}`);
    const nextQuotes = payload.quotes || [];
    const updatedAt = new Date().toLocaleTimeString();
    setQuotesForTab(watchlist.id, nextQuotes);
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

    const freshRowIds = nextMtfs
      .filter((quote) => previousRows[quote.symbol] !== nextRows[quote.symbol])
      .map((quote) => mtfRowId(tab, quote.symbol));
    if (freshRowIds.length) {
      setNewMtfRows((current) => ({
        ...current,
        ...Object.fromEntries(freshRowIds.map((id) => [id, true])),
      }));
    }

    const matches = describeMtfMatches(nextMtfs);
    const message = matches || "No symbols are on MTF clouds now.";
    addNotification({
      title: "MTFs changed",
      message,
      kind: "changed",
    });
    showMtfDeviceNotification(message, nextMtfs.length);
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

  function toggleStrategy(strategyId) {
    setStrategyState((current) => {
      const next = { ...current, [strategyId]: current[strategyId] === false };
      saveStrategyState(next);
      return next;
    });
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

  async function refreshAppMarketData() {
    await refreshWatchlists();
    await refreshAllPrices();
  }

  function showMtfDeviceNotification(body, badgeCount) {
    if (!notificationState.appEnabled || notificationState.permission !== "granted") return;
    showDeviceNotification({
      title: "MTFs changed",
      body,
      badgeCount,
      tag: "mtf-update",
      url: "/",
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

  function startLiveRefresh() {
    if (liveTimer.current) clearInterval(liveTimer.current);
    setLiveRefreshActive(true);
    loadLivePrices({ manual: true });
    liveTimer.current = setInterval(() => loadLivePrices(), MARKET_REFRESH_INTERVAL_MS);
  }

  function stopLiveRefresh() {
    if (liveTimer.current) clearInterval(liveTimer.current);
    liveTimer.current = null;
    setLiveRefreshActive(false);
    setUpdatedTextForTab(watchlistTabRef.current, "Webull polling stopped");
  }

  useEffect(() => {
    refreshShell();
    refreshAppMarketData();
    watchlistSyncTimer.current = setInterval(() => refreshWatchlists(), WATCHLIST_SYNC_INTERVAL_MS);
    loadNotificationState()
      .then(setNotificationState)
      .catch(() => {
        setNotificationState((current) => ({ ...current, supported: false }));
      });
    return () => {
      if (liveTimer.current) clearInterval(liveTimer.current);
      if (watchlistSyncTimer.current) clearInterval(watchlistSyncTimer.current);
    };
  }, []);

  useEffect(() => {
    function refreshWhenVisible() {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastFocusRefreshAt.current < 10000) return;
      lastFocusRefreshAt.current = now;
      refreshAppMarketData();
    }

    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", refreshWhenVisible);
    return () => {
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("focus", refreshWhenVisible);
    };
  }, []);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return undefined;
    function handleServiceWorkerMessage(event) {
      if (event.data?.type !== "MTF_PUSH_UPDATE") return;
      refreshAppMarketData();
    }

    navigator.serviceWorker.addEventListener("message", handleServiceWorkerMessage);
    return () => navigator.serviceWorker.removeEventListener("message", handleServiceWorkerMessage);
  }, []);

  useEffect(() => {
    const canBadge = notificationState.appEnabled && notificationState.permission === "granted";
    setAppBadgeCount(canBadge ? unreadNotificationCount : 0).catch(() => {});
  }, [notificationState.appEnabled, notificationState.permission, unreadNotificationCount]);

  useEffect(() => {
    strategyStateRef.current = strategyState;
  }, [strategyState]);

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
        liveRefreshActive={liveRefreshActive}
        loading={loading}
        pageLoading={pageLoading}
        onRefresh={refreshShell}
        onStart={startLiveRefresh}
        onStop={stopLiveRefresh}
        onSelectAccount={setSelectedAccountId}
        notificationState={notificationState}
        onEnableNotifications={enableAppNotifications}
        onDisableNotifications={disableAppNotifications}
        notifications={notifications}
        onMarkNotificationsRead={markNotificationsRead}
        strategyState={strategyState}
        onToggleStrategy={toggleStrategy}
      />
      {pageLoading ? <div className="loading-blocker" aria-hidden="true"></div> : null}
      <main className="shell">
        {pageLoading ? <div className="top-loading-bar" aria-label="Loading"></div> : null}
        {alert ? <div className="alert app-alert">{alert}</div> : null}

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
            <div className="section-heading">
              <div>
                <h2>{activeWatchlist?.name || "Watchlist"}</h2>
                <p className="muted">Live Webull prices with clock-aligned EMA levels.</p>
              </div>
              <div className="live-price-actions">
                <button type="button" onClick={() => loadLivePrices({ manual: true })} disabled={loading.prices}>
                  {loading.prices ? <LoadingLabel label="Refreshing" /> : "Refresh Prices"}
                </button>
              </div>
            </div>

            {liveAlert ? <div className="alert">{liveAlert}</div> : null}

            <div className="active-watchlist-tables">
              <div className="trend-price-grid">
                <PriceBucket title="Bullish" quotes={trendBuckets.bullish} kind="bullish" loading={loading.prices} onRemoveSymbol={(symbol) => removeSymbolFromWatchlist(symbol)} />
                <PriceBucket title="Bearish" quotes={trendBuckets.bearish} kind="bearish" loading={loading.prices} onRemoveSymbol={(symbol) => removeSymbolFromWatchlist(symbol)} />
                <PriceBucket title="Chop" quotes={trendBuckets.chop} kind="chop" loading={loading.prices} onRemoveSymbol={(symbol) => removeSymbolFromWatchlist(symbol)} />
              </div>
              <p className="muted">{updatedText}</p>
            </div>
          </section>
          <aside className="global-mtf-panel" aria-label="MTFs from all tabs">
            <MtfTable
              quotes={allMtfs}
              title="MTFs"
              showWatchlist
              loading={loading.prices || loading.watchlists}
              onDismissNew={(quote) => dismissNewMtfRow(quote.watchlist_id, quote.symbol)}
            />
          </aside>
        </div>
        <HiddenLegacyPanels />
      </main>
    </>
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
          {loading ? <LoadingLabel label="Loading" /> : "Refresh All"}
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
          <button type="submit" disabled={loading}>{loading ? <LoadingLabel label="Saving" /> : "Add"}</button>
        </form>
      </div>
    </section>
  );
}

function LoadingLabel({ label }) {
  return (
    <span className="loading-label">
      <span className="loading-spinner" aria-hidden="true"></span>
      {label}
    </span>
  );
}
