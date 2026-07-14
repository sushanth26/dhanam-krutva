import { useEffect, useMemo, useRef, useState } from "react";

import { Header } from "./components/Header";
import { HiddenLegacyPanels } from "./components/HiddenLegacyPanels";
import { HomePage } from "./components/HomePage";
import { MtfAlertsPage, longAlertRows } from "./components/MtfAlertsPage";
import { SettingsMenu, normalizeAutoTradeSettings } from "./components/SettingsMenu";
import { useAppNotifications } from "./hooks/useAppNotifications";
import { useLatestRef } from "./hooks/useLatestRef";
import { useLoadingState } from "./hooks/useLoadingState";
import { useShellData } from "./hooks/useShellData";
import { fetchAlertStrategies, saveAlertStrategiesRemote } from "./lib/alertStrategies";
import { deleteJson, getJson, postJson } from "./lib/api";
import { pageFromLocationHash, hashForPage } from "./lib/appNavigation";
import { trendBucketsForQuotes } from "./lib/appSelectors";
import { formatMarketTime } from "./lib/dates";
import { longAlertNotification, longAlertSignature } from "./lib/longAlertNotifications";
import { isMarketRefreshWindow, marketDateKey, marginTradingAccountId } from "./lib/market";
import { showDeviceNotification } from "./lib/notifications";
import { loadAutoTradeSettings, loadRiskSettings, normalizeRiskSettings, saveAutoTradeSettings, saveRiskSettings } from "./lib/settings";
import { initialTabState, loadWatchlists, normalizeSymbols, normalizeWatchlists, OG_WATCHLIST_ID, saveWatchlists, shouldPromoteLocalWatchlists, slugify, uniqueId } from "./lib/watchlists";

const PASSIVE_MARKET_REFRESH_INTERVAL_MS = 2 * 60 * 1000;
const WATCHLIST_SYNC_INTERVAL_MS = 2 * 60 * 1000;
const LIVE_DATA_UNLOCK_KEY = "dhanam-live-data-unlock-date";

export default function App() {
  const [watchlists, setWatchlists] = useState(loadWatchlists);
  const [quotesByTab, setQuotesByTab] = useState(() => initialTabState(loadWatchlists(), []));
  const [mtfAlertHistory, setMtfAlertHistory] = useState([]);
  const [updatedTextByTab, setUpdatedTextByTab] = useState(() => initialTabState(loadWatchlists(), "Webull polling stopped"));
  const [liveAlert, setLiveAlert] = useState("");
  const [activePage, setActivePage] = useState(() => pageFromLocationHash(window.location.hash));
  const [riskSettings, setRiskSettings] = useState(loadRiskSettings);
  const [autoTrade, setAutoTrade] = useState(loadAutoTradeSettings);
  const [watchlistTab, setWatchlistTab] = useState(OG_WATCHLIST_ID);
  const [symbolInputs, setSymbolInputs] = useState({});
  const { loading, pageLoading, setLoadingKey } = useLoadingState();
  const {
    accounts,
    alert,
    refreshShell,
    selectAccount,
    selectedAccountId,
    status,
  } = useShellData({ setLoadingKey });
  const {
    addNotification,
    disableAppNotifications,
    enableAppNotifications,
    markNotificationsRead,
    notifications,
    notificationState,
  } = useAppNotifications({ setLiveAlert, setLoadingKey });
  const passiveMarketTimer = useRef(null);
  const watchlistSyncTimer = useRef(null);
  const lastMtfSignature = useRef(initialTabState(loadWatchlists(), null));
  const lastMtfRows = useRef(initialTabState(loadWatchlists(), {}));
  const riskSettingsRef = useLatestRef(riskSettings);
  const autoTradeRef = useLatestRef(autoTrade);
  const watchlistTabRef = useLatestRef(watchlistTab);
  const watchlistsRef = useLatestRef(watchlists);
  const notificationStateRef = useLatestRef(notificationState);
  const activeWatchlist = watchlists.find((item) => item.id === watchlistTab) || watchlists[0];
  const quotes = quotesByTab[watchlistTab] || [];
  const updatedText = updatedTextByTab[watchlistTab] || "";
  const tradingAccountId = useMemo(() => marginTradingAccountId(accounts, selectedAccountId), [accounts, selectedAccountId]);
  const trendBuckets = useMemo(() => trendBucketsForQuotes(quotes), [quotes]);
  const mtfAlertRows = useMemo(() => mtfAlertHistory, [mtfAlertHistory]);

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
    if (!manual && !isLiveDataApprovedToday()) {
      setUpdatedTextForTab(watchlistTabRef.current, "Auto-refresh waits for your first manual pull today");
      return;
    }
    if (!manual && !isMarketRefreshWindow()) {
      setUpdatedTextForTab(watchlistTabRef.current, "Auto-refresh paused outside market hours");
      return;
    }

    setLiveAlert("");
    if (showLoading) setLoadingKey("prices", true);
    try {
      const activeTab = watchlistTabRef.current;
      const selectedWatchlist = watchlistsRef.current.find((item) => item.id === activeTab);
      await refreshWatchlistPrices(selectedWatchlist, { manual });
      if (manual) unlockLiveDataForToday();
    } catch (error) {
      setLiveAlert(error.message);
    } finally {
      if (showLoading) setLoadingKey("prices", false);
    }
  }

  async function refreshAllPrices({ showLoading = true, manual = true } = {}) {
    if (!manual && !isLiveDataApprovedToday()) {
      setLiveAlert("Auto-refresh waits for your first manual pull today.");
      return;
    }
    if (!manual && !isMarketRefreshWindow()) return;

    setLiveAlert("");
    if (showLoading) setLoadingKey("prices", true);
    try {
      const lists = watchlistsRef.current;
      for (const watchlist of lists) {
        await refreshWatchlistPrices(watchlist, { manual });
      }
      if (manual) unlockLiveDataForToday();
    } catch (error) {
      setLiveAlert(error.message);
    } finally {
      if (showLoading) setLoadingKey("prices", false);
    }
  }

  async function refreshWatchlistPrices(watchlist, { manual = false } = {}) {
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
    if (manual) query.set("manual", "true");
    const payload = await getJson(`/api/webull/live-prices?${query.toString()}`);
    const nextQuotes = payload.quotes || [];
    const updatedAt = formatMarketTime(new Date());
    setQuotesForTab(watchlist.id, nextQuotes);
    setUpdatedTextForTab(watchlist.id, `Updated ${updatedAt} from ${payload.source || "webull"}`);
    notifyLongAlerts(watchlist, nextQuotes);

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

  function navigatePage(page) {
    setActivePage(page);
    const hash = hashForPage(page);
    window.history.replaceState(null, "", hash || window.location.pathname);
  }

  function notifyLongAlerts(watchlist, nextQuotes) {
    const rows = longAlertRows([watchlist], { [watchlist.id]: nextQuotes }, autoTradeRef.current.strategies);
    const signature = longAlertSignature(rows);
    if (!signature || signature === lastMtfSignature.current[watchlist.id]) {
      lastMtfSignature.current = { ...lastMtfSignature.current, [watchlist.id]: signature || null };
      return;
    }
    lastMtfSignature.current = { ...lastMtfSignature.current, [watchlist.id]: signature };
    saveMtfAlertRows(rows).catch(() => {});
    const { title, message } = longAlertNotification(rows);
    addNotification({ title, message, kind: "mtf" });
    if (notificationStateRef.current.appEnabled && notificationStateRef.current.permission === "granted") {
      showDeviceNotification({
        title,
        body: message,
        tag: `long-mtf-${watchlist.id}`,
        url: "/#mtfs",
      }).catch(() => {});
    }
  }

  async function saveMtfAlertRows(rows) {
    const alerts = rows.map((row) => ({
      ...row,
      id: longAlertSignature([row]),
      symbol: row.quote?.symbol,
      created_at: new Date().toISOString(),
    }));
    const payload = await postJson("/api/webull/mtf-alerts", { alerts });
    setMtfAlertHistory(normalizeStoredAlertRows(payload.alerts || []));
  }

  async function deleteMtfAlert(id) {
    if (!id) return;
    try {
      const payload = await deleteJson(`/api/webull/mtf-alerts/${encodeURIComponent(id)}`);
      setMtfAlertHistory(normalizeStoredAlertRows(payload.alerts || []));
    } catch (error) {
      setLiveAlert(error.message);
    }
  }

  function updateAutoTradeSettings(nextSettings) {
    const normalized = normalizeAutoTradeSettings(nextSettings, autoTradeRef.current.strategies);
    setAutoTrade(normalized);
    autoTradeRef.current = normalized;
    saveAutoTradeSettings(normalized);
    lastMtfSignature.current = initialTabState(watchlistsRef.current, null);
    saveAlertStrategiesRemote(normalized.strategies).catch(() => {});
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
    setWatchlistTab((current) => next.some((item) => item.id === current) ? current : OG_WATCHLIST_ID);
  }

  function isLiveDataApprovedToday(date = new Date()) {
    return window.localStorage.getItem(LIVE_DATA_UNLOCK_KEY) === marketDateKey(date);
  }

  function canKeepPassiveRefreshArmed(date = new Date()) {
    const day = date.getDay();
    if (day === 0 || day === 6) return false;
    const minutes = date.getHours() * 60 + date.getMinutes();
    return isLiveDataApprovedToday(date) && minutes < 19 * 60;
  }

  function unlockLiveDataForToday() {
    window.localStorage.setItem(LIVE_DATA_UNLOCK_KEY, marketDateKey());
    startPassiveMarketRefresh();
  }

  function startPassiveMarketRefresh() {
    if (passiveMarketTimer.current) return;
    passiveMarketTimer.current = setInterval(() => {
      if (!canKeepPassiveRefreshArmed()) {
        stopPassiveMarketRefresh();
        return;
      }
      if (isMarketRefreshWindow()) {
        refreshAllPrices({ showLoading: false, manual: false });
      }
    }, PASSIVE_MARKET_REFRESH_INTERVAL_MS);
  }

  function stopPassiveMarketRefresh() {
    if (!passiveMarketTimer.current) return;
    clearInterval(passiveMarketTimer.current);
    passiveMarketTimer.current = null;
  }

  useEffect(() => {
    refreshShell({ includeAccounts: true });
    loadMtfAlertHistory();
    refreshWatchlists();
    if (canKeepPassiveRefreshArmed()) startPassiveMarketRefresh();
    watchlistSyncTimer.current = setInterval(() => refreshWatchlists({ showLoading: false }), WATCHLIST_SYNC_INTERVAL_MS);
    return () => {
      stopPassiveMarketRefresh();
      if (watchlistSyncTimer.current) clearInterval(watchlistSyncTimer.current);
    };
  }, []);

  async function loadMtfAlertHistory() {
    try {
      const payload = await getJson("/api/webull/mtf-alerts");
      setMtfAlertHistory(normalizeStoredAlertRows(payload.alerts || []));
    } catch {
      setMtfAlertHistory([]);
    }
  }

  useEffect(() => {
    fetchAlertStrategies()
      .then((strategies) => {
        const next = { ...autoTradeRef.current, strategies: { ...autoTradeRef.current.strategies, ...strategies } };
        autoTradeRef.current = next;
        setAutoTrade(next);
        saveAutoTradeSettings(next);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return undefined;
    function handleServiceWorkerMessage(event) {
      if (event.data?.type !== "MTF_PUSH_UPDATE") return;
      navigatePage("mtfs");
    }

    navigator.serviceWorker.addEventListener("message", handleServiceWorkerMessage);
    return () => navigator.serviceWorker.removeEventListener("message", handleServiceWorkerMessage);
  }, []);

  return (
    <>
      <Header
        status={status}
        accounts={accounts}
        selectedAccountId={selectedAccountId}
        loading={loading}
        pageLoading={pageLoading}
        onRefresh={() => refreshShell({ includeAccounts: true })}
        onSelectAccount={selectAccount}
        notificationState={notificationState}
        onEnableNotifications={enableAppNotifications}
        onDisableNotifications={disableAppNotifications}
        notifications={notifications}
        onMarkNotificationsRead={markNotificationsRead}
        activePage={activePage}
        onNavigate={navigatePage}
        settingsBadge={autoTrade.enabled ? "Auto" : "Rules"}
        settingsControls={(
          <SettingsMenu
            accountId={tradingAccountId}
            autoTrade={autoTrade}
            disabled={loading.prices}
            onApplyRisk={refreshAllPrices}
            onAutoTradeChange={updateAutoTradeSettings}
            onRiskChange={updateRiskSettings}
            riskSettings={riskSettings}
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
        {alert ? <div className="alert app-alert">{alert}</div> : null}

        {activePage === "mtfs" ? (
          <MtfAlertsPage
            loading={loading.prices}
            onDeleteAlert={deleteMtfAlert}
            onRefresh={refreshAllPrices}
            rows={mtfAlertRows}
          />
        ) : (
          <HomePage
            activeWatchlist={activeWatchlist}
            liveAlert={liveAlert}
            loading={loading}
            onAddSymbols={addSymbolsToActiveWatchlist}
            onAddTab={addWatchlist}
            onDeleteTab={deleteWatchlist}
            onRefreshAll={refreshAllPrices}
            onRefreshPrices={() => loadLivePrices({ manual: true })}
            onRemoveSymbol={(symbol) => removeSymbolFromWatchlist(symbol)}
            onSymbolInput={(value) => setSymbolInputs((current) => ({ ...current, [watchlistTab]: value }))}
            onSwitchTab={switchWatchlistTab}
            onToggleAutoTrade={toggleWatchlistAutoTrade}
            symbolInput={symbolInputs[watchlistTab] || ""}
            trendBuckets={trendBuckets}
            updatedText={updatedText}
            watchlistTab={watchlistTab}
            watchlists={watchlists}
          />
        )}
        <HiddenLegacyPanels />
      </main>
    </>
  );
}

function normalizeStoredAlertRows(alerts) {
  return alerts
    .map((row) => ({
      ...row,
      watchlist: row.watchlist || { id: "stored", name: row.list || "Stored alerts" },
      quote: row.quote || { symbol: row.symbol },
      match: row.match || {},
    }))
    .filter((row) => row.quote?.symbol && row.match?.type)
    .sort((left, right) => String(right.match.candle_time || right.created_at || "").localeCompare(String(left.match.candle_time || left.created_at || "")));
}
