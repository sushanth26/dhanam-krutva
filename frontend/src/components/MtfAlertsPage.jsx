import { formatDateTime } from "../lib/dates";
import { formatPrice } from "../lib/market";
import { SummaryTile } from "./SummaryTile";

const LIVE_LONG_SETUP_TYPES = new Set(["long_mtf_5_12_touch", "10m_34_50_bounce"]);

export function longAlertRows(watchlists, quotesByTab) {
  return watchlists.flatMap((watchlist) => {
    const quotes = quotesByTab[watchlist.id] || [];
    return quotes.flatMap((quote) => {
      const matches = (quote.mtf_matches || []).filter((match) => match.trade_action === "Long" && LIVE_LONG_SETUP_TYPES.has(match.type));
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
          <p className="muted">Live long setups for Curls and confirmed 10m 34/50 Bounces.</p>
        </div>
        <button type="button" className="secondary-button" onClick={() => onRefresh()} disabled={loading}>
          {loading ? "Refreshing" : "Refresh"}
        </button>
      </div>
      <div className="mtf-alert-counts" aria-label="Setup alert counts">
        <SummaryTile label="Live Setups" value={rows.length} />
        <SummaryTile label="Curls" value={rows.filter((row) => row.match.type === "long_mtf_5_12_touch").length} />
        <SummaryTile label="34/50 Bounce" value={rows.filter((row) => row.match.type === "10m_34_50_bounce").length} />
        <SummaryTile label="Symbols" value={new Set(rows.map((row) => row.quote.symbol)).size} />
      </div>
      <div className="mtf-alert-table-wrap">
        <table className="mtf-alert-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>List</th>
              <th>Setup</th>
              <th>Trend</th>
              <th>Entry</th>
              <th>Trigger</th>
              <th>Alert Time</th>
            </tr>
          </thead>
          <tbody>
            {rows.length ? rows.map((row, index) => (
              <tr key={`${row.watchlist.id}-${row.quote.symbol}-${row.match.mtf_label}-${row.match.candle_time || index}`}>
                <td data-label="Symbol"><strong>{row.quote.symbol}</strong></td>
                <td data-label="List">{row.watchlist.name}</td>
                <td data-label="Setup">
                  <div className="mtf-alert-setup">
                    <strong>{row.match.display_label || row.match.label}</strong>
                    <span>{formatPrice(row.match.cloud_low)}-{formatPrice(row.match.cloud_high)} {row.match.cloud_label || "10m 5/12"}</span>
                  </div>
                </td>
                <td data-label="Trend"><span className={`trend-pill ${String(row.match.trend || "").toLowerCase()}`}>{row.match.trend || "-"}</span></td>
                <td data-label="Entry">{formatPrice(row.match.entry_price)}</td>
                <td data-label="Trigger"><SetupTriggerList match={row.match} /></td>
                <td data-label="Alert Time">{formatDateTime(row.match.candle_time)}</td>
              </tr>
            )) : (
              <tr>
                <td colSpan="7" className="empty-table-cell">No setups right now</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SetupTriggerList({ match }) {
  if (match.type === "10m_34_50_bounce") {
    return (
      <div className="mtf-touch-list">
        <span>
          <strong>10m 34/50</strong>
          Confirmed close
        </span>
      </div>
    );
  }

  const touches = Array.isArray(match.mtf_touches) && match.mtf_touches.length
    ? match.mtf_touches
    : [{ label: match.mtf_label, touch_time: match.mtf_touch_time }];
  return (
    <div className="mtf-touch-list">
      {touches.map((touch, index) => (
        <span key={`${touch.label || "mtf"}-${touch.touch_time || index}`}>
          <strong>{touch.label || "-"}</strong>
          {formatDateTime(touch.touch_time)}
        </span>
      ))}
    </div>
  );
}
