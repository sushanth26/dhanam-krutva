import { useEffect, useMemo, useRef, useState } from "react";

import { Header } from "./components/Header";
import { HiddenLegacyPanels } from "./components/HiddenLegacyPanels";
import { MtfTable, PriceBucket } from "./components/PriceTables";
import { getJson } from "./lib/api";
import { filterQuotesByStrategy, loadStrategyState, saveStrategyState } from "./lib/alertStrategies";
import { cloudStatus, describeMtfMatches, findAccountId, flattenAccounts, isMarketRefreshWindow, mtfSignature } from "./lib/market";
import { disableNotifications, enableNotifications, loadNotificationState, setAppBadgeCount, showDeviceNotification, syncNotificationPreferences } from "./lib/notifications";

const MARKET_REFRESH_INTERVAL_MS = 15000;
const MAX_NOTIFICATIONS = 20;
const DAILY_SYMBOLS_KEY = "dhanam-daily-symbols";

function loadDailySymbols() {
  try {
    const value = JSON.parse(window.localStorage.getItem(DAILY_SYMBOLS_KEY) || "[]");
    return Array.isArray(value) ? normalizeSymbols(value) : [];
  } catch {
    return [];
  }
}

function saveDailySymbols(symbols) {
  window.localStorage.setItem(DAILY_SYMBOLS_KEY, JSON.stringify(symbols));
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

export default function App() {
  const [status, setStatus] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useState(null);
  const [quotesByTab, setQuotesByTab] = useState({ og: [], daily: [] });
  const [updatedTextByTab, setUpdatedTextByTab] = useState({
    og: "Webull polling stopped",
    daily: "Daily list selected",
  });
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
  const [watchlistTab, setWatchlistTab] = useState("og");
  const [dailySymbols, setDailySymbols] = useState(loadDailySymbols);
  const [dailySymbolInput, setDailySymbolInput] = useState("");
  const liveTimer = useRef(null);
  const lastMtfSignature = useRef({ og: null, daily: null });
  const strategyStateRef = useRef(strategyState);
  const watchlistTabRef = useRef(watchlistTab);
  const dailySymbolsRef = useRef(dailySymbols);
  const quotes = quotesByTab[watchlistTab] || [];
  const updatedText = updatedTextByTab[watchlistTab] || "";

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
  const mtfs = useMemo(() => {
    return filterQuotesByStrategy(quotes.filter((quote) => quote.mtf_matches?.length), strategyState);
  }, [quotes, strategyState]);
  const unreadNotificationCount = useMemo(() => notifications.filter((item) => !item.read).length, [notifications]);

  async function refreshShell() {
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
    }
  }

  async function loadLivePrices({ manual = false } = {}) {
    if (!manual && !isMarketRefreshWindow()) {
      setUpdatedTextForTab(watchlistTabRef.current, "Auto-refresh paused until premarket open");
      return;
    }

    setLiveAlert("");
    try {
      const activeTab = watchlistTabRef.current;
      const dailyMode = activeTab === "daily";
      const selectedSymbols = dailyMode ? dailySymbolsRef.current : [];
      if (dailyMode && !selectedSymbols.length) {
        setQuotesForTab(activeTab, []);
        setUpdatedTextForTab(activeTab, "Add symbols to the Daily list");
        return;
      }
      const query = dailyMode ? `?symbols=${encodeURIComponent(selectedSymbols.join(","))}` : "";
      const payload = await getJson(`/api/webull/live-prices${query}`);
      const nextQuotes = payload.quotes || [];
      const updatedAt = new Date().toLocaleTimeString();
      setQuotesForTab(activeTab, nextQuotes);
      setUpdatedTextForTab(activeTab, `Updated ${updatedAt} from ${payload.source || "webull"}`);
      notifyMtfUpdate(activeTab, filterQuotesByStrategy(nextQuotes.filter((quote) => quote.mtf_matches?.length), strategyStateRef.current));

      if (payload.errors?.length) {
        setLiveAlert(`Some data failed: ${payload.errors.map((item) => item.source).join(", ")}`);
      }
    } catch (error) {
      setLiveAlert(error.message);
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
    const changed = previousSignature !== null && signature !== previousSignature;
    lastMtfSignature.current = { ...lastMtfSignature.current, [tab]: signature };
    if (!changed) return;

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

  function toggleStrategy(strategyId) {
    setStrategyState((current) => {
      const next = { ...current, [strategyId]: current[strategyId] === false };
      saveStrategyState(next);
      return next;
    });
    lastMtfSignature.current = { og: null, daily: null };
  }

  function addDailySymbols(event) {
    event.preventDefault();
    const incoming = normalizeSymbols([dailySymbolInput]);
    if (!incoming.length) return;
    setDailySymbols((current) => {
      const next = normalizeSymbols([...current, ...incoming]).slice(0, 25);
      saveDailySymbols(next);
      return next;
    });
    setDailySymbolInput("");
    lastMtfSignature.current = { ...lastMtfSignature.current, daily: null };
  }

  function removeDailySymbol(symbol) {
    setDailySymbols((current) => {
      const next = current.filter((item) => item !== symbol);
      saveDailySymbols(next);
      return next;
    });
    setQuotesByTab((current) => ({
      ...current,
      daily: current.daily.filter((quote) => quote.symbol !== symbol),
    }));
    lastMtfSignature.current = { ...lastMtfSignature.current, daily: null };
  }

  function switchWatchlistTab(tab) {
    setWatchlistTab(tab);
    setUpdatedTextByTab((current) => ({
      ...current,
      [tab]: current[tab] || (tab === "daily" ? "Daily list selected" : "OG list selected"),
    }));
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
    }
  }

  async function disableAppNotifications() {
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
    loadNotificationState()
      .then(setNotificationState)
      .catch(() => {
        setNotificationState((current) => ({ ...current, supported: false }));
      });
    return () => {
      if (liveTimer.current) clearInterval(liveTimer.current);
    };
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
    dailySymbolsRef.current = dailySymbols;
  }, [dailySymbols]);

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
      <main className="shell">
        {alert ? <div className="alert app-alert">{alert}</div> : null}

        <section className="live-prices-panel">
          <WatchlistTabs
            activeTab={watchlistTab}
            dailySymbolInput={dailySymbolInput}
            dailySymbols={dailySymbols}
            onAddDailySymbols={addDailySymbols}
            onDailySymbolInput={setDailySymbolInput}
            onRemoveDailySymbol={removeDailySymbol}
            onSwitchTab={switchWatchlistTab}
          />
          <div className="section-heading">
            <div>
              <h2>{watchlistTab === "daily" ? "Daily List" : "OG List"}</h2>
              <p className="muted">Live Webull prices with clock-aligned EMA levels.</p>
            </div>
            <div className="live-price-actions">
              <button type="button" onClick={() => loadLivePrices({ manual: true })}>Refresh Prices</button>
            </div>
          </div>

          {liveAlert ? <div className="alert">{liveAlert}</div> : null}

          <MtfTable quotes={mtfs} />
          <div className="trend-price-grid">
            <PriceBucket title="Bullish" quotes={trendBuckets.bullish} kind="bullish" />
            <PriceBucket title="Bearish" quotes={trendBuckets.bearish} kind="bearish" />
            <PriceBucket title="Chop" quotes={trendBuckets.chop} kind="chop" />
          </div>
          <p className="muted">{updatedText}</p>
        </section>
        <HiddenLegacyPanels />
      </main>
    </>
  );
}

function WatchlistTabs({
  activeTab,
  dailySymbolInput,
  dailySymbols,
  onAddDailySymbols,
  onDailySymbolInput,
  onRemoveDailySymbol,
  onSwitchTab,
}) {
  return (
    <section className="watchlist-panel" aria-label="Watchlists">
      <div className="watchlist-tabs" role="tablist" aria-label="Watchlist tabs">
        <button
          type="button"
          className={activeTab === "og" ? "active" : ""}
          onClick={() => onSwitchTab("og")}
          role="tab"
          aria-selected={activeTab === "og"}
        >
          OG list
        </button>
        <button
          type="button"
          className={activeTab === "daily" ? "active" : ""}
          onClick={() => onSwitchTab("daily")}
          role="tab"
          aria-selected={activeTab === "daily"}
        >
          Daily list
          <span>{dailySymbols.length}</span>
        </button>
      </div>
      {activeTab === "daily" ? (
        <div className="daily-list-editor">
          <form onSubmit={onAddDailySymbols}>
            <input
              aria-label="Add daily symbols"
              placeholder="Add ticker"
              value={dailySymbolInput}
              onChange={(event) => onDailySymbolInput(event.target.value)}
            />
            <button type="submit">Add</button>
          </form>
          <div className="daily-symbols" aria-label="Daily symbols">
            {dailySymbols.length ? dailySymbols.map((symbol) => (
              <span key={symbol}>
                {symbol}
                <button type="button" onClick={() => onRemoveDailySymbol(symbol)} aria-label={`Remove ${symbol}`}>x</button>
              </span>
            )) : <em>Add tickers for today.</em>}
          </div>
        </div>
      ) : null}
    </section>
  );
}
