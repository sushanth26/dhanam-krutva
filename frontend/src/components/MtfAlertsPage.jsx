import { useMemo, useState } from "react";

import { alertStrategyEnabled } from "../lib/alertStrategies";
import { formatDateTime } from "../lib/dates";
import { formatPrice } from "../lib/market";

const LIVE_LONG_SETUP_TYPES = new Set(["long_mtf_5_12_touch", "10m_34_50_bounce"]);

export function longAlertRows(watchlists, quotesByTab, strategies = {}) {
  return watchlists.flatMap((watchlist) => {
    const quotes = quotesByTab[watchlist.id] || [];
    return quotes
      .filter((quote) => quote.scanner_read?.kind === "entry")
      .flatMap((quote) => {
        const sourceMatch = entrySourceMatch(quote);
        if (!sourceMatch || !alertStrategyEnabled(sourceMatch, strategies)) return [];
        return [{ watchlist, quote, match: entryAlertMatch(quote, sourceMatch) }];
      });
  });
}

function entrySourceMatch(quote) {
  const read = quote.scanner_read || {};
  const sourceType = read.source_match_type;
  return (quote.mtf_matches || []).find((match) => match.type === sourceType)
    || (quote.mtf_matches || []).find((match) => match.trade_action === "Long" && LIVE_LONG_SETUP_TYPES.has(match.type) && match.setup_quality !== "bad")
    || null;
}

function entryAlertMatch(quote, sourceMatch) {
  const read = quote.scanner_read || {};
  return {
    ...sourceMatch,
    type: "scanner_entry",
    source_type: sourceMatch.type,
    label: "Entry",
    display_label: `Entry: ${read.reason || "at 9EMA"}`,
    entry_price: read.entry_price || sourceMatch.entry_price || quote.price,
    candle_time: read.candle_time || sourceMatch.candle_time,
    scanner_read: read,
  };
}

export function MtfAlertsPage({ loading, onDeleteAlert, onRefresh, rows }) {
  const [searchText, setSearchText] = useState("");
  const sortedRows = useMemo(() => [...rows].sort(compareAlertRows), [rows]);
  const visibleRows = useMemo(() => filterRows(sortedRows, searchText), [sortedRows, searchText]);

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
      <div className="mtf-alert-legend" aria-label="Setup row color key">
        <span className="mtf-alert-legend-item curl"><b></b>Curl</span>
        <span className="mtf-alert-legend-item bounce-good"><b></b>Good 10m bounce</span>
        <span className="mtf-alert-legend-item bounce-bad"><b></b>Weak 10m bounce</span>
        <span className="mtf-alert-legend-item cloud-touch"><b></b>MTF cloud touch</span>
      </div>
      <label className="mtf-alert-search">
        <span>Search alerts</span>
        <input
          type="search"
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
          placeholder="Symbol, setup, trend"
        />
      </label>
      <div className="mtf-alert-table-wrap">
        <table className="mtf-alert-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Setup</th>
              <th>Trend</th>
              <th>Entry</th>
              <th>Alert Time</th>
              <th aria-label="Actions"></th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.length ? visibleRows.map((row, index) => (
              <tr
                key={`${row.watchlist.id}-${row.quote.symbol}-${row.match.label}-${row.match.mtf_label || ""}-${row.match.candle_time || index}`}
                className={`mtf-alert-row ${setupClass(row.match)}`}
              >
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
                <td data-label="Alert Time">{formatDateTime(row.match.candle_time)}</td>
                <td data-label="Actions" className="mtf-alert-actions">
                  <button
                    type="button"
                    className="row-delete-button"
                    onClick={() => onDeleteAlert(row.id)}
                    aria-label={`Delete ${row.quote.symbol} alert`}
                    title="Delete alert"
                  >
                    x
                  </button>
                </td>
              </tr>
            )) : (
              <tr>
                <td colSpan="6" className="empty-table-cell">{rows.length ? "No alerts match this search" : "No stored alerts yet"}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function compareAlertRows(left, right) {
  return alertTimestamp(right) - alertTimestamp(left);
}

function alertTimestamp(row) {
  const value = row.match?.candle_time || row.created_at;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function filterRows(rows, query) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return rows;
  return rows.filter((row) => searchableText(row).includes(normalizedQuery));
}

function searchableText(row) {
  return [
    row.quote?.symbol,
    row.watchlist?.name,
    row.match?.display_label,
    row.match?.label,
    row.match?.trend,
    row.match?.setup_quality,
    row.match?.setup_quality_note,
    row.match?.mtf_label,
    row.match?.cloud_label,
    row.match?.type,
  ].filter(Boolean).join(" ").toLowerCase();
}

function setupClass(match) {
  if (match.type === "scanner_entry") return setupClass({ ...match, type: match.source_type });
  if (match.type === "long_mtf_5_12_touch") return "curl";
  if (match.type === "10m_34_50_bounce") return match.setup_quality === "bad" ? "bounce-bad" : "bounce-good";
  if (match.type === "mtf_cloud_price_touch") return "cloud-touch";
  return "other";
}
