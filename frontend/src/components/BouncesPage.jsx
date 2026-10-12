import { useEffect, useState } from "react";

import { getJson } from "../lib/api";

const REFRESH_MS = 60 * 1000;

function price(value) {
  return value == null ? "–" : Number(value).toFixed(2);
}

export function BouncesPage() {
  const [alerts, setAlerts] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const body = await getJson("/api/strategy/bounces");
        if (!alive) return;
        setAlerts(body.alerts || []);
        setError("");
      } catch (err) {
        if (alive) setError(err.message);
      }
    }
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <section className="bounces-page">
      {error ? <p className="bounces-error">{error}</p> : null}
      <div className="bounces-wrap">
        <table className="bounces-table">
          <thead>
            <tr>
              <th>Alert</th>
              <th className="bounces-symbol">Stock</th>
              <th>Entry</th>
              <th>SL</th>
              <th>S1</th>
              <th>S2</th>
              <th>R1</th>
              <th>R2</th>
            </tr>
          </thead>
          <tbody>
            {alerts.length ? alerts.map((alert) => (
              <tr key={alert.id} className={alert.side}>
                <td className="bounces-alert">
                  <span><em>{alert.symbol}</em> {alert.time}</span>
                  <i>{alert.side === "long" ? "▲" : "▼"}</i>
                  <b>{alert.side === "long" ? "Bounce" : "Reject"}</b> {alert.cloud}
                </td>
                <td className="bounces-symbol">{alert.symbol}</td>
                <td>{price(alert.entry)}</td>
                <td>{price(alert.stop)}</td>
                <td>{price(alert.s1)}</td>
                <td>{price(alert.s2)}</td>
                <td>{price(alert.r1)}</td>
                <td>{price(alert.r2)}</td>
              </tr>
            )) : (
              <tr>
                <td colSpan={8} className="bounces-empty">No alerts yet</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
