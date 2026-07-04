import { useEffect, useMemo, useRef, useState } from "react";

import { Header } from "./components/Header";
import { HiddenLegacyPanels } from "./components/HiddenLegacyPanels";
import { AlarmPanel } from "./components/AlarmPanel";
import { MtfTable, PriceBucket } from "./components/PriceTables";
import { getJson } from "./lib/api";
import { cloudStatus, describeMtfMatches, findAccountId, flattenAccounts, isMarketRefreshWindow, mtfSignature } from "./lib/market";
import { enableNotifications, loadNotificationState, sendTestPush, showDeviceNotification } from "./lib/notifications";

const MARKET_REFRESH_INTERVAL_MS = 15000;
const DUMMY_MTF_MESSAGE = "MTFs changed: ASTS Hourly 34/50 • AMD Daily 20/21 • BE Daily 50/55 • LLY Hourly 34/50 + Daily 20/21";
const DUMMY_MTF_BODY = "ASTS Hourly 34/50 | AMD Daily 20/21 | BE Daily 50/55 | LLY Hourly 34/50 + Daily 20/21";

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
  const [alarm, setAlarm] = useState({ message: "", changed: false });
  const liveTimer = useRef(null);
  const alarmTimer = useRef(null);
  const lastMtfSignature = useRef(null);

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
  const mtfs = useMemo(() => quotes.filter((quote) => quote.mtf_matches?.length), [quotes]);

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
      notifyMtfUpdate(nextQuotes.filter((quote) => quote.mtf_matches?.length), updatedAt);

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
    showAlarm(
      changed ? `MTFs changed: ${matches || "no matches"}` : `MTFs updated ${updatedAt}: ${matches || "no matches"}`,
      changed,
    );
    if (changed) {
      showMtfDeviceNotification(matches || "No symbols are on MTF clouds now.");
    }
  }

  function showAlarm(message, changed = false) {
    setAlarm({ message, changed });
    if (alarmTimer.current) clearTimeout(alarmTimer.current);
    alarmTimer.current = setTimeout(() => setAlarm({ message: "", changed: false }), changed ? 14000 : 10000);
  }

  function showMtfDeviceNotification(body) {
    showDeviceNotification({
      title: "MTFs changed",
      body,
      tag: "mtf-update",
      url: "/",
    }).catch((error) => setLiveAlert(error.message));
  }

  async function enableAppNotifications() {
    try {
      const nextState = await enableNotifications();
      setNotificationState(nextState);
      if (nextState.permission === "granted") {
        showAlarm(
          nextState.webPushConfigured && nextState.subscribed
            ? "App notifications enabled. Railway can send MTF push alerts."
            : "Device notifications enabled. Add VAPID keys for closed-app push alerts.",
          true,
        );
      }
    } catch (error) {
      setLiveAlert(error.message);
    }
  }

  async function testMtfNotification() {
    showAlarm(DUMMY_MTF_MESSAGE, true);
    showMtfDeviceNotification(DUMMY_MTF_BODY);
    if (notificationState.webPushConfigured && notificationState.subscribed) {
      try {
        await sendTestPush();
      } catch (error) {
        setLiveAlert(error.message);
      }
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
      if (alarmTimer.current) clearTimeout(alarmTimer.current);
    };
  }, []);

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
        onTestNotification={testMtfNotification}
      />
      <main className="shell">
        <AlarmPanel message={alarm.message} changed={alarm.changed} />

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
