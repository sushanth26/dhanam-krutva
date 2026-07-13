import { alertStrategyEnabled } from "../lib/alertStrategies";
import { formatDateTime } from "../lib/dates";
import { formatPrice } from "../lib/market";
import { SummaryTile } from "./SummaryTile";

const LIVE_LONG_SETUP_TYPES = new Set(["long_mtf_5_12_touch", "10m_34_50_bounce"]);
const TOUCH_ALERT_TYPES = new Set(["mtf_cloud_price_touch"]);

export function longAlertRows(watchlists, quotesByTab, strategies = {}) {
  return watchlists.flatMap((watchlist) => {
    const quotes = quotesByTab[watchlist.id] || [];
    return quotes.flatMap((quote) => {
      const matches = (quote.mtf_matches || []).filter((match) => (
        (
          (match.trade_action === "Long" && LIVE_LONG_SETUP_TYPES.has(match.type))
          || TOUCH_ALERT_TYPES.has(match.type)
        )
        && alertStrategyEnabled(match, strategies)
      ));
      return matches.map((match) => ({ watchlist, quote, match }));
    });
  });
}

export function MtfAlertsPage({ loading, onRefresh, rows }) {
  return (
    <section className="mtf-alerts-page" aria-label="Setup alerts">
      <div className="mtf-alerts-header">
        <div>
          <h2>Setups</h2>
          <p className="muted">Live long setups for Curls and confirmed 10m 34/50 Bounces, plus MTF cloud touch alerts.</p>
        </div>
        <button type="button" className="secondary-button" onClick={() => onRefresh()} disabled={loading}>
          {loading ? "Refreshing" : "Refresh"}
        </button>
      </div>
      <div className="mtf-alert-counts" aria-label="Setup alert counts">
        <SummaryTile label="Live Setups" value={rows.length} />
        <SummaryTile label="Curls" value={rows.filter((row) => row.match.type === "long_mtf_5_12_touch").length} />
        <SummaryTile label="34/50 Bounce" value={rows.filter((row) => row.match.type === "10m_34_50_bounce").length} />
        <SummaryTile label="Cloud Touch" value={rows.filter((row) => row.match.type === "mtf_cloud_price_touch").length} />
        <SummaryTile label="Symbols" value={new Set(rows.map((row) => row.quote.symbol)).size} />
      </div>
      <div className="mtf-alert-table-wrap">
        <table className="mtf-alert-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Setup</th>
              <th>Trend</th>
              <th>Entry</th>
              <th>SL</th>
              <th>Quantity</th>
              <th>Alert Time</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? rows.map((row, index) => (
              <tr key={`${row.watchlist.id}-${row.quote.symbol}-${row.match.label}-${row.match.mtf_label || ""}-${row.match.candle_time || index}`}>
                <td data-label="Symbol"><strong>{row.quote.symbol}</strong></td>
                <td data-label="Setup">
                  <div className="mtf-alert-setup">
                    <strong>{row.match.display_label || row.match.label}</strong>
                    <span>{formatPrice(row.match.cloud_low)}-{formatPrice(row.match.cloud_high)} {row.match.cloud_label || "10m 5/12"}</span>
                    {row.match.setup_quality_note ? <span>{row.match.setup_quality_note}</span> : null}
                  </div>
                </td>
                <td data-label="Trend"><span className={`trend-pill ${String(row.match.trend || "").toLowerCase()}`}>{row.match.trend || "-"}</span></td>
                <td data-label="Entry">{formatPrice(row.match.entry_price)}</td>
                <td data-label="SL">{formatPrice(row.match.risk_plan?.stop)}</td>
                <td data-label="Quantity">{formatQuantity(row.match.risk_plan?.shares)}</td>
                <td data-label="Alert Time">{formatDateTime(row.match.candle_time)}</td>
              </tr>
            )) : (
              <tr>
                <td colSpan="7" className="empty-table-cell">No stored alerts yet</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function formatQuantity(value) {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity <= 0) return "-";
  return String(Math.floor(quantity));
}
