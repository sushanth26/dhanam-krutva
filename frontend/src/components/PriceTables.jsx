import { CloudTag, MtfTag } from "./Tags";
import { cloudStatus, formatPrice } from "../lib/market";

export function MtfTable({
  quotes,
  showWatchlist = false,
  title = "MTFs",
  buyState = {},
  emptyText = "No stocks are on hourly or daily EMA clouds right now.",
  focusedSymbol = "",
  onBuy,
  onDismissNew,
}) {
  return (
    <section className="price-bucket mtf-bucket">
      <div className="bucket-heading">
        <h3>{title}</h3>
        <span>{quotes.length}</span>
      </div>
      <div className="live-price-table-wrap">
        <table className={`live-price-table ${showWatchlist ? "global-mtf-table" : ""}`}>
          <thead>
            <tr>
              <th>Symbol</th>
              {showWatchlist ? <th>List</th> : null}
              <th>On EMA</th>
              <th>Time</th>
              <th className="action-col" aria-label="Actions"></th>
            </tr>
          </thead>
          <tbody>
            {quotes.length ? quotes.map((quote) => (
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

function MtfRow({ buyState, focused, quote, showWatchlist, onBuy, onDismissNew }) {
  const triggerTime = mtfTriggerTime(quote.mtf_matches);
  const dismissNew = quote.is_new ? () => onDismissNew?.(quote) : undefined;
  const waiting = quote.mtf_matches?.some((match) => match.status === "waiting");
  return (
    <BaseRow
      className={focused ? "focused-mtf-row" : ""}
      id={`mtf-row-${quote.symbol}`}
      quote={quote}
      showPrice={false}
      onClick={dismissNew}
      action={(
        <BuyCell
          buyState={buyState}
          disabled={!onBuy}
          onBuy={() => onBuy?.(quote)}
          symbol={quote.symbol}
          waiting={waiting}
        />
      )}
    >
      {showWatchlist ? (
        <td className="watchlist-cell">
          {quote.watchlist_name || "-"}
          {quote.is_new ? <NewTag onDismiss={dismissNew} symbol={quote.symbol} /> : null}
        </td>
      ) : null}
      <td className="mtf-tags">
        {quote.mtf_matches.map((match) => (
          <span key={match.label} className="mtf-tag-group">
            <MtfTag label={match.label} />
            {match.trend ? <CloudTag status={match.trend} /> : null}
          </span>
        ))}
      </td>
      <td className="trigger-time">{triggerTime}</td>
    </BaseRow>
  );
}

function BuyCell({ buyState, disabled, onBuy, symbol, waiting }) {
  if (waiting) {
    return <td className="row-action-cell buy-action-cell" aria-label="Waiting for candle close"></td>;
  }
  const loading = buyState?.status === "loading";
  const title = `Buy 1 share of ${symbol}`;
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

function BaseRow({ quote, children, trend = "", action = null, className = "", id, showPrice = true, onClick }) {
  const rowClass = [trend ? `trend-${String(trend).toLowerCase()}` : "", className].filter(Boolean).join(" ");
  return (
    <tr className={`stock-row ${rowClass}`} id={id} onClick={onClick}>
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
