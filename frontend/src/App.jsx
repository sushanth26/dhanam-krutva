import { useEffect, useMemo, useRef, useState } from "react";

import { Header } from "./components/Header";
import { HiddenLegacyPanels } from "./components/HiddenLegacyPanels";
import { MtfTable, PriceBucket } from "./components/PriceTables";
import { MtfToast } from "./components/MtfToast";
import { getJson } from "./lib/api";
import { describeMtfMatches, findAccountId, flattenAccounts, isMarketRefreshWindow, mtfSignature } from "./lib/market";
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
  const [toast, setToast] = useState({ message: "", changed: false });
  const liveTimer = useRef(null);
  const toastTimer = useRef(null);
  const lastMtfSignature = useRef(null);

  const green = useMemo(() => quotes.filter((quote) => Number(quote.change) > 0), [quotes]);
  const red = useMemo(() => quotes.filter((quote) => Number(quote.change) < 0), [quotes]);
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
    showToast(
      changed ? `MTFs changed: ${matches || "no matches"}` : `MTFs updated ${updatedAt}: ${matches || "no matches"}`,
      changed,
    );
    if (changed) {
      showMtfDeviceNotification(matches || "No symbols are on MTF clouds now.");
    }
  }

  function showToast(message, changed = false) {
    setToast({ message, changed });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast({ message: "", changed: false }), changed ? 14000 : 10000);
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
        showToast(
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
    showToast(DUMMY_MTF_MESSAGE, true);
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
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  return (
    <>
      <MtfToast message={toast.message} changed={toast.changed} />
      <main className="shell">
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
        />

        {alert ? <div className="alert app-alert">{alert}</div> : null}

        <section className="live-prices-panel">
          <div className="section-heading">
            <div>
              <h2>Webull Live Prices</h2>
              <p className="muted">Live Webull prices with clock-aligned EMA levels.</p>
            </div>
            <div className="live-price-actions">
              <button className="secondary-button" type="button" onClick={testMtfNotification}>
                Test Alert
              </button>
              <button type="button" onClick={() => loadLivePrices({ manual: true })}>Refresh Prices</button>
            </div>
          </div>

          {liveAlert ? <div className="alert">{liveAlert}</div> : null}

          <MtfTable quotes={mtfs} />
          <div className="split-price-grid">
            <PriceBucket title="Green" quotes={green} kind="green" />
            <PriceBucket title="Red" quotes={red} kind="red" />
          </div>
          <p className="muted">{updatedText}</p>
        </section>
        <HiddenLegacyPanels />
      </main>
    </>
  );
}
