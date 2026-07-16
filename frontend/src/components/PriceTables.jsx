import { useMemo, useState } from "react";

import { CloudTag } from "./Tags";
import { cloudStatus, formatPrice } from "../lib/market";

export function MtfTable({
  quotes,
  showWatchlist = false,
  title = "MTFs",
  subtitle = "",
  buyState = {},
  emptyText = "No stocks are on hourly or daily EMA clouds right now.",
  focusedSymbol = "",
  onBuy,
  onDismissNew,
}) {
  const sortedQuotes = [...quotes].sort(compareMtfQuoteRecency);

  return (
    <section className="price-bucket mtf-bucket">
      <div className="bucket-heading">
        <div className="bucket-title">
          <h3>{title}</h3>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        <span>{quotes.length}</span>
      </div>
      <div className="live-price-table-wrap">
        <table className={`live-price-table ${showWatchlist ? "global-mtf-table" : ""}`}>
          <thead>
            <tr>
              <th>Symbol</th>
              {showWatchlist ? <th>Watchlist</th> : null}
              <th>Trade plan</th>
              <th>Time</th>
              <th className="action-col" aria-label="Actions"></th>
            </tr>
          </thead>
          <tbody>
            {sortedQuotes.length ? sortedQuotes.map((quote) => (
              <MtfRow
                key={`${quote.watchlist_id || "tab"}-${quote.symbol}`}
                buyState={buyState[quote.symbol]}
                focused={quote.symbol === focusedSymbol}
                quote={quote}
                showWatchlist={showWatchlist}
                onBuy={onBuy}
                onDismissNew={onDismissNew}
              />
            )) : (
              <tr><td colSpan={showWatchlist ? 5 : 4}>{emptyText}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function PriceBucket({ title, quotes, kind, onRemoveSymbol }) {
  return (
    <section className="price-bucket">
      <div className="bucket-heading">
        <h3>{title}</h3>
        <span>{quotes.length}</span>
      </div>
      <div className="live-price-table-wrap">
        <table className="live-price-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Trend</th>
              <th className="price-col">Last</th>
              {onRemoveSymbol ? <th className="action-col" aria-label="Actions"></th> : null}
            </tr>
          </thead>
          <tbody>
            {quotes.length ? quotes.map((quote) => (
              <PriceRow key={quote.symbol} quote={quote} onRemoveSymbol={onRemoveSymbol} />
            )) : (
              <tr><td colSpan={onRemoveSymbol ? "4" : "3"}>No {kind} stocks right now.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function PreMarketScannerTable({ rows }) {
  const [listSort, setListSort] = useState(null);
  const sortedRows = useMemo(() => sortScannerRows(rows, listSort), [rows, listSort]);

  function toggleListSort() {
    setListSort((current) => (current === "asc" ? "desc" : "asc"));
  }

  return (
    <section className="price-bucket premarket-scanner-bucket">
      <div className="bucket-heading">
        <h3>Pre Market Scanner</h3>
        <span>{rows.length}</span>
      </div>
      <div className="live-price-table-wrap">
        <table className="live-price-table premarket-scanner-table">
          <thead>
            <tr>
              <th>Stock</th>
              <th>Short or Long</th>
              <th>10m Trend</th>
              <th>Above/Below YH/YL</th>
              <th className="price-col">Last</th>
              <th className="price-col">YH</th>
              <th className="price-col">YL</th>
              <th className="price-col">Move</th>
              <th>
                <button
                  type="button"
                  className="scanner-sort-button"
                  onClick={toggleListSort}
                  aria-label={`Sort scanner by list ${listSort === "asc" ? "descending" : "ascending"}`}
                >
                  List {listSort ? <span>{listSort === "asc" ? "A-Z" : "Z-A"}</span> : null}
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.length ? sortedRows.map((row) => (
              <tr key={row.symbol} className={`stock-row scanner-${row.action.toLowerCase()}`}>
                <td data-label="Stock"><strong>{row.symbol}</strong></td>
                <td data-label="Action">
                  <span className={`scanner-action ${row.action.toLowerCase()}`}>{row.action}</span>
                </td>
                <td data-label="10m Trend"><CloudTag status={row.trend} /></td>
                <td data-label="Trigger">{row.trigger}</td>
                <td data-label="Last" className="price-cell">{formatPrice(row.price)}</td>
                <td data-label="YH" className="price-cell">{formatPrice(row.previousHigh)}</td>
                <td data-label="YL" className="price-cell">{formatPrice(row.previousLow)}</td>
                <td data-label="Move" className="price-cell">{formatPercent(row.distancePct)}</td>
                <td data-label="List">{row.watchlistName || "-"}</td>
              </tr>
            )) : (
              <tr className="scanner-empty-row"><td colSpan="9">No aligned breakouts: longs need above YH + bullish 10m cloud; shorts need below YL + bearish 10m cloud.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function formatPercent(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${numeric.toFixed(2)}%` : "-";
}

function sortScannerRows(rows, listSort) {
  if (!listSort) return rows;
  return [...rows].sort((left, right) => {
    const listCompare = String(left.watchlistName || "").localeCompare(String(right.watchlistName || ""));
    const symbolCompare = String(left.symbol || "").localeCompare(String(right.symbol || ""));
    return listSort === "asc"
      ? listCompare || symbolCompare
      : -listCompare || symbolCompare;
  });
}

function MtfRow({ buyState, focused, quote, showWatchlist, onBuy, onDismissNew }) {
  const triggerTime = mtfTriggerTime(quote.mtf_matches);
  const riskPlan = aPlusPlusRiskPlan(quote.mtf_matches);
  const tradeAction = tradeActionForMatches(quote.mtf_matches);
  const dismissNew = quote.is_new ? () => onDismissNew?.(quote) : undefined;
  const rowId = ["mtf-row", quote.watchlist_id || "tab", quote.symbol].join("-");
  return (
    <BaseRow
      className={focused ? "focused-mtf-row" : ""}
      dataMtfSymbol={quote.symbol}
      id={rowId}
      quote={quote}
      showPrice={false}
      onClick={dismissNew}
      action={(
        <BuyCell
          buyState={buyState}
          disabled={!onBuy}
          onBuy={() => onBuy?.(quote)}
          symbol={quote.symbol}
          tradeAction={tradeAction}
        />
      )}
    >
      {showWatchlist ? (
        <td className="watchlist-cell">
          {quote.watchlist_name || "-"}
          {quote.is_new ? <NewTag onDismiss={dismissNew} symbol={quote.symbol} /> : null}
        </td>
      ) : null}
      <td className="mtf-plan-cell">
        {riskPlan ? <RiskPlan plan={riskPlan} /> : <span className="confirmed-setup">Confirmed</span>}
      </td>
      <td className="trigger-time">{triggerTime}</td>
    </BaseRow>
  );
}

function compareMtfQuoteRecency(left, right) {
  const rightTime = latestMtfTime(right);
  const leftTime = latestMtfTime(left);
  if (rightTime !== leftTime) return rightTime - leftTime;
  return String(left.symbol || "").localeCompare(String(right.symbol || ""));
}

function latestMtfTime(quote) {
  const times = (quote.mtf_matches || [])
    .map((match) => Date.parse(match.candle_time || ""))
    .filter(Number.isFinite);
  return times.length ? Math.max(...times) : 0;
}

function RiskPlan({ plan }) {
  return (
    <span className="risk-plan">
      <span>Entry {formatPrice(plan.entry)}</span>
      Qty <b>{plan.shares}</b>
      <span>SL {formatPrice(plan.stop)}</span>
      <small>Risk {formatPrice(plan.risk_per_share)}/sh</small>
      {plan.volatility?.grade ? (
        <small>{volatilityLabel(plan.volatility)}</small>
      ) : null}
    </span>
  );
}

function BuyCell({ buyState, disabled, onBuy, symbol, tradeAction }) {
  if (!tradeAction) {
    return <td className="row-action-cell buy-action-cell" aria-label="Watch alert"></td>;
  }
  if (tradeAction === "Short") {
    return (
      <td className="row-action-cell buy-action-cell">
        <button type="button" className="buy-one short-signal" disabled title={`Short signal for ${symbol}; short order is not wired yet.`}>
          Short
        </button>
      </td>
    );
  }
  const loading = buyState?.status === "loading";
  const title = `Auto buy calculated size for ${symbol}`;
  return (
    <td className="row-action-cell buy-action-cell">
      <button
        type="button"
        className={`buy-one ${buyState?.status === "ok" ? "success" : ""} ${buyState?.status === "error" ? "error" : ""}`}
        disabled={disabled || loading}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onBuy?.();
        }}
        title={title}
        aria-label={title}
      >
        {loading ? "Buying" : "Buy"}
      </button>
    </td>
  );
}

function NewTag({ onDismiss, symbol }) {
  function dismiss(event) {
    event.preventDefault();
    event.stopPropagation();
    onDismiss?.();
  }

  return (
    <button
      type="button"
      className="new-mtf-tag"
      onClick={dismiss}
      onPointerDown={dismiss}
      aria-label={`Clear new alert for ${symbol}`}
    >
      NEW
    </button>
  );
}

function PriceRow({ quote, onRemoveSymbol }) {
  const tenMinuteStatus = cloudStatus(quote.ema_10m, ["5", "12"], ["34", "50"]);
  return (
    <BaseRow quote={quote} trend={tenMinuteStatus} action={onRemoveSymbol ? <RemoveCell onRemove={() => onRemoveSymbol(quote.symbol)} symbol={quote.symbol} /> : null}>
      <td><CloudTag status={tenMinuteStatus} /></td>
    </BaseRow>
  );
}

function BaseRow({ quote, children, trend = "", action = null, className = "", dataMtfSymbol, id, showPrice = true, onClick }) {
  const rowClass = [trend ? `trend-${String(trend).toLowerCase()}` : "", className].filter(Boolean).join(" ");
  return (
    <tr className={`stock-row ${rowClass}`} data-mtf-symbol={dataMtfSymbol} id={id} onClick={onClick}>
      <td><strong>{quote.symbol}</strong></td>
      {children}
      {showPrice ? <td className="price-cell">{formatPrice(quote.price)}</td> : null}
      {action}
    </tr>
  );
}

function RemoveCell({ onRemove, symbol }) {
  return (
    <td className="row-action-cell">
      <button type="button" className="row-delete-button" onClick={onRemove} aria-label={`Remove ${symbol}`}>
        x
      </button>
    </td>
  );
}

function mtfTriggerTime(matches) {
  const match = (matches || []).find((item) => item.candle_time);
  if (!match) return "-";
  const parsed = new Date(match.candle_time);
  if (Number.isNaN(parsed.getTime())) return String(match.candle_time);
  const date = parsed.toLocaleDateString([], { month: "short", day: "numeric" });
  const time = parsed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${date} ${time}`;
}

function aPlusPlusRiskPlan(matches) {
  return (matches || []).find((match) => match.trade_action === "Long" && match.risk_plan)?.risk_plan || null;
}

function tradeActionForMatches(matches) {
  const actions = new Set((matches || []).map((match) => match.trade_action).filter(Boolean));
  if (actions.has("Long") && !actions.has("Short")) return "Long";
  if (actions.has("Short") && !actions.has("Long")) return "Short";
  return "";
}

function volatilityLabel(volatility) {
  const grade = String(volatility.grade || "unknown");
  const range = volatility.average_range == null ? "" : ` ${formatPrice(volatility.average_range)} avg`;
  return `${grade}${range}`;
}
