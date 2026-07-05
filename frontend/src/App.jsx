import { useEffect, useMemo, useRef, useState } from "react";

import { Header } from "./components/Header";
import { HiddenLegacyPanels } from "./components/HiddenLegacyPanels";
import { MtfTable, PriceBucket } from "./components/PriceTables";
import { getJson } from "./lib/api";
import { filterQuotesByStrategy, loadStrategyState, saveStrategyState } from "./lib/alertStrategies";
import { cloudStatus, describeMtfMatches, findAccountId, flattenAccounts, isMarketRefreshWindow, mtfSignature } from "./lib/market";
import { enableNotifications, loadNotificationState, setAppBadgeCount, showDeviceNotification, syncNotificationPreferences } from "./lib/notifications";

const MARKET_REFRESH_INTERVAL_MS = 15000;
const MAX_NOTIFICATIONS = 20;

export default function App() {
  const [status, setStatus] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [selectedAccountId, setSelectedAccountId] = useState(null);
  const [quotes, setQuotes] = useState([]);
  const [updatedText, setUpdatedText] = useState("Webull polling stopped");
  const [alert, setAlert] = useState("");
  const [liveAlert, setLiveAlert] = useState("");
  const [liveRefreshActive, setLiveRefreshActive] = useState(false);
  const [notificationState, setNotificationState] = useState({
    supported: false,
    permission: "default",
    webPushConfigured: false,
    subscribed: false,
  });
  const [notifications, setNotifications] = useState([]);
  const [strategyState, setStrategyState] = useState(loadStrategyState);
  const liveTimer = useRef(null);
  const lastMtfSignature = useRef(null);
  const strategyStateRef = useRef(strategyState);

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
      setUpdatedText("Auto-refresh paused until premarket open");
      return;
    }

    setLiveAlert("");
    try {
      const payload = await getJson("/api/webull/live-prices");
      const nextQuotes = payload.quotes || [];
      const updatedAt = new Date().toLocaleTimeString();
      setQuotes(nextQuotes);
      setUpdatedText(`Updated ${updatedAt} from ${payload.source || "webull"}`);
      notifyMtfUpdate(filterQuotesByStrategy(nextQuotes.filter((quote) => quote.mtf_matches?.length), strategyStateRef.current), updatedAt);

      if (payload.errors?.length) {
        setLiveAlert(`Some data failed: ${payload.errors.map((item) => item.source).join(", ")}`);
      }
    } catch (error) {
      setLiveAlert(error.message);
    }
  }

  function notifyMtfUpdate(nextMtfs, updatedAt) {
    const signature = mtfSignature(nextMtfs);
    const changed = lastMtfSignature.current !== null && signature !== lastMtfSignature.current;
    lastMtfSignature.current = signature;
    const matches = describeMtfMatches(nextMtfs);
    addNotification({
      title: changed ? "MTFs changed" : "MTFs updated",
      message: changed ? matches || "No matches" : `${updatedAt}: ${matches || "No matches"}`,
      kind: changed ? "changed" : "update",
    });
    if (changed) {
      showMtfDeviceNotification(matches || "No symbols are on MTF clouds now.", nextMtfs.length);
    }
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
    lastMtfSignature.current = null;
  }

  function showMtfDeviceNotification(body, badgeCount) {
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
    setUpdatedText("Webull polling stopped");
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
    setAppBadgeCount(unreadNotificationCount).catch(() => {});
  }, [unreadNotificationCount]);

  useEffect(() => {
    strategyStateRef.current = strategyState;
  }, [strategyState]);

  useEffect(() => {
    syncNotificationPreferences(strategyState).catch(() => {});
  }, [strategyState]);

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
        notifications={notifications}
        onMarkNotificationsRead={markNotificationsRead}
        strategyState={strategyState}
        onToggleStrategy={toggleStrategy}
      />
      <main className="shell">
        {alert ? <div className="alert app-alert">{alert}</div> : null}

        <section className="live-prices-panel">
          <div className="section-heading">
            <div>
              <h2>Webull Live Prices</h2>
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
