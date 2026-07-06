import { CloudTag, MtfTag } from "./Tags";
import { cloudStatus, formatPrice, groupBySector, sectorSlug } from "../lib/market";

export function MtfTable({ quotes, showWatchlist = false, title = "MTFs", onDismissNew }) {
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
            </tr>
          </thead>
          <tbody>
            {quotes.length ? quotes.map((quote) => (
              <MtfRow
                key={`${quote.watchlist_id || "tab"}-${quote.symbol}`}
                quote={quote}
                showWatchlist={showWatchlist}
                onDismissNew={onDismissNew}
              />
            )) : (
              <tr><td colSpan={showWatchlist ? "4" : "3"}>No stocks are on hourly or daily EMA clouds right now.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function PriceBucket({ title, quotes, kind, onRemoveSymbol }) {
  const grouped = groupBySector(quotes);
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
            {quotes.length ? Object.entries(grouped).map(([sector, sectorQuotes]) => (
              <SectorRows key={sector} sector={sector} quotes={sectorQuotes} onRemoveSymbol={onRemoveSymbol} />
            )) : (
              <tr><td colSpan={onRemoveSymbol ? "4" : "3"}>No {kind} stocks right now.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SectorRows({ sector, quotes, onRemoveSymbol }) {
  return (
    <>
      <tr className={`sector-row sector-${sectorSlug(sector)}`}>
        <td colSpan={onRemoveSymbol ? "4" : "3"}>{sector}</td>
      </tr>
      {quotes.map((quote) => <PriceRow key={quote.symbol} quote={quote} onRemoveSymbol={onRemoveSymbol} />)}
    </>
  );
}

function MtfRow({ quote, showWatchlist, onDismissNew }) {
  const triggerTime = mtfTriggerTime(quote.mtf_matches);
  return (
    <BaseRow quote={quote} showPrice={false}>
      {showWatchlist ? (
        <td className="watchlist-cell">
          {quote.watchlist_name || "-"}
          {quote.is_new ? <NewTag onDismiss={() => onDismissNew?.(quote)} symbol={quote.symbol} /> : null}
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

function NewTag({ onDismiss, symbol }) {
  return (
    <button type="button" className="new-mtf-tag" onClick={onDismiss} aria-label={`Clear new alert for ${symbol}`}>
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

function BaseRow({ quote, children, trend = "", action = null, showPrice = true }) {
  const rowClass = trend ? `trend-${String(trend).toLowerCase()}` : "";
  return (
    <tr className={`stock-row ${rowClass}`}>
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
