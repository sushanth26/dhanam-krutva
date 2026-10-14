import { useEffect, useRef, useState } from "react";

import { getJson, postJson } from "../lib/api";
import { showDeviceNotification } from "../lib/notifications";

const REFRESH_MS = 60 * 1000;
const SEEN_KEY = "dhanam-bounce-seen";
const FRESH_MS = 15 * 60 * 1000; // only ping for alerts whose candle closed in the last 15 min
const NEW_HIGHLIGHT_MS = 10 * 60 * 1000;

// Cloud colors: 1H 34/50 orange, D 20/21 yellow, D 50/55 blue
const CLOUD_CLASS = { "1H 34/50": "cloud-h1", "D 20/21": "cloud-d20", "D 50/55": "cloud-d50" };

function loadSeen() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(SEEN_KEY) || "null");
    return Array.isArray(saved) ? new Set(saved) : null;
  } catch {
    return null;
  }
}

function saveSeen(ids) {
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify([...ids].slice(-500)));
  } catch {
    // storage unavailable: alerts still show, just no memory across reloads
  }
}

function beep() {
  try {
    const context = new (window.AudioContext || window.webkitAudioContext)();
    const tone = context.createOscillator();
    const gain = context.createGain();
    tone.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.4);
    tone.connect(gain).connect(context.destination);
    tone.start();
    tone.stop(context.currentTime + 0.4);
  } catch {
    // audio blocked until the page has been interacted with
  }
}

function notifyNewAlert(alert) {
  // Same tag as the server push, so a device that gets both shows it once.
  showDeviceNotification({
    title: `${alert.symbol} ${alert.alert}`,
    body: `Entry ${price(alert.entry)} · SL ${price(alert.stop)}`,
    tag: `bounce-${alert.id}`,
    url: "/#bounces",
  }).catch(() => {});
}

// End-of-day review: how each alert actually played out
const VERDICTS = [
  ["worked", "✓", "Worked"],
  ["failed", "✗", "Failed"],
  ["choppy", "~", "Choppy"],
];

function VerdictButtons({ alert, onMark }) {
  return (
    <span className="bounces-verdict">
      {VERDICTS.map(([value, icon, label]) => (
        <button
          key={value}
          type="button"
          title={label}
          className={`${value} ${alert.verdict === value ? "on" : ""}`}
          onClick={(event) => {
            event.stopPropagation();
            onMark(alert, alert.verdict === value ? null : value);
          }}
        >
          {icon}
        </button>
      ))}
    </span>
  );
}

function lists(alert) {
  return (alert.watchlists || []).join(", ");
}

function price(value) {
  return value == null ? "–" : Number(value).toFixed(2);
}

// Ripster exit: a 10-min close through the 5/12 cloud, or the stop
function ExitTag({ alert }) {
  const ex = alert.exit;
  if (alert.premarket) return null;
  if (!ex) return <span className="bounces-exit open">In trade</span>;
  const r = `${ex.r >= 0 ? "+" : ""}${ex.r.toFixed(1)}R`;
  return (
    <span className={`bounces-exit ${ex.r >= 0 ? "win" : "loss"}`} title={`${ex.time} ${ex.label} @ ${price(ex.price)}`}>
      {ex.label} {r}
    </span>
  );
}

function BounceTable({ title, side, alerts, newIds, onMark }) {

  return (
    <section className={`bounces-group ${side}`}>
      <h2>
        {title} <span>{alerts.length}</span>
      </h2>
      <div className="bounces-names">
        {/* Phones: time + name per alert, colored by cloud */}
        {alerts.length
          ? alerts.map((alert) => (
            <b key={alert.id} className={`${CLOUD_CLASS[alert.cloud]} ${newIds.has(alert.id) ? "is-new" : ""}`}>
              <small>{alert.time}</small> {alert.symbol}
              {lists(alert) ? <i>{lists(alert)}</i> : null}
              <ExitTag alert={alert} />
              <VerdictButtons alert={alert} onMark={onMark} />
            </b>
          ))
          : <em>None yet</em>}
      </div>
      <div className="bounces-wrap">
        <table className="bounces-table">
          <thead>
            <tr>
              <th>Alert</th>
              <th>Stock</th>
              <th>List</th>
              <th>Entry</th>
              <th>SL</th>
              <th>Exit</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {alerts.length ? alerts.map((alert) => (
              <tr key={alert.id} className={newIds.has(alert.id) ? "is-new" : ""}>
                <td className="bounces-alert">
                  <span>{alert.time}</span>
                  <b className={CLOUD_CLASS[alert.cloud]}>{alert.cloud}</b>
                </td>
                <td className="bounces-symbol">{alert.symbol}</td>
                <td className="bounces-list">{lists(alert)}</td>
                <td>{price(alert.entry)}</td>
                <td>{price(alert.stop)}</td>
                <td><ExitTag alert={alert} /></td>
                <td><VerdictButtons alert={alert} onMark={onMark} /></td>
              </tr>
            )) : (
              <tr>
                <td colSpan={7} className="bounces-empty">None yet</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function BouncesPage() {
  const [alerts, setAlerts] = useState([]);
  const [error, setError] = useState("");
  const [newIds, setNewIds] = useState(() => new Set());
  const seenRef = useRef(loadSeen());

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const body = await getJson("/api/strategy/bounces");
        if (!alive) return;
        const next = body.alerts || [];
        setAlerts(next);
        setError(body.error ? `Showing last update (${body.error})` : "");
        markNew(next);
      } catch (err) {
        if (alive) setError(err.message);
      }
    }
    function markNew(next) {
      const seen = seenRef.current;
      seenRef.current = new Set([...(seen || []), ...next.map((alert) => alert.id)]);
      saveSeen(seenRef.current);
      if (!seen) return; // first visit on this device: everything is the baseline
      const fresh = next.filter((alert) => !seen.has(alert.id));
      if (!fresh.length) return;
      setNewIds((current) => new Set([...current, ...fresh.map((alert) => alert.id)]));
      window.setTimeout(() => {
        setNewIds((current) => new Set([...current].filter((id) => !fresh.some((alert) => alert.id === id))));
      }, NEW_HIGHLIGHT_MS);
      const recent = fresh.filter((alert) => Date.now() - Date.parse(alert.bar_close) < FRESH_MS);
      if (recent.length) {
        beep();
        recent.forEach(notifyNewAlert);
      }
    }

    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  async function mark(alert, verdict) {
    const apply = (value) => setAlerts((current) => current.map((item) => (item.id === alert.id ? { ...item, verdict: value } : item)));
    apply(verdict);
    try {
      const { verdict: _ignored, ...snapshot } = alert;
      await postJson("/api/strategy/bounces/feedback", { alert: snapshot, verdict });
    } catch (err) {
      apply(alert.verdict ?? null);
      setError(`Couldn't save: ${err.message}`);
    }
  }

  return (
    <section className="bounces-page">
      {error ? <p className="bounces-error">{error}</p> : null}
      <div className="bounces-legend">
        {Object.entries(CLOUD_CLASS).map(([cloud, className]) => <b key={cloud} className={className}>{cloud}</b>)}
      </div>
      <BounceTable title="Bullish" side="long" alerts={alerts.filter((alert) => alert.side === "long")} newIds={newIds} onMark={mark} />
      <BounceTable title="Bearish" side="short" alerts={alerts.filter((alert) => alert.side === "short")} newIds={newIds} onMark={mark} />
    </section>
  );
}
