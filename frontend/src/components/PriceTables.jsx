import { CloudTag, MtfTag } from "./Tags";
import { cloudStatus, formatPrice, groupBySector, sectorSlug } from "../lib/market";

export function MtfTable({ quotes }) {
  return (
    <section className="price-bucket mtf-bucket">
      <div className="bucket-heading">
        <h3>MTFs</h3>
        <span>{quotes.length}</span>
      </div>
      <div className="live-price-table-wrap">
        <table className="live-price-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>On EMA</th>
              <th>Time</th>
              <th className="price-col">Last</th>
            </tr>
          </thead>
          <tbody>
            {quotes.length ? quotes.map((quote) => <MtfRow key={quote.symbol} quote={quote} />) : (
              <tr><td colSpan="4">No stocks are on hourly or daily EMA clouds right now.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function PriceBucket({ title, quotes, kind }) {
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
            </tr>
          </thead>
          <tbody>
            {quotes.length ? Object.entries(grouped).map(([sector, sectorQuotes]) => (
              <SectorRows key={sector} sector={sector} quotes={sectorQuotes} />
            )) : (
              <tr><td colSpan="3">No {kind} stocks right now.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SectorRows({ sector, quotes }) {
  return (
    <>
      <tr className={`sector-row sector-${sectorSlug(sector)}`}>
        <td colSpan="3">{sector}</td>
      </tr>
      {quotes.map((quote) => <PriceRow key={quote.symbol} quote={quote} />)}
    </>
  );
}

function MtfRow({ quote }) {
  const triggerTime = mtfTriggerTime(quote.mtf_matches);
  return (
    <BaseRow quote={quote}>
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

function PriceRow({ quote }) {
  const tenMinuteStatus = cloudStatus(quote.ema_10m, ["5", "12"], ["34", "50"]);
  return (
    <BaseRow quote={quote} trend={tenMinuteStatus}>
      <td><CloudTag status={tenMinuteStatus} /></td>
    </BaseRow>
  );
}

function BaseRow({ quote, children, trend = "" }) {
  const rowClass = trend ? `trend-${String(trend).toLowerCase()}` : "";
  return (
    <tr className={`stock-row ${rowClass}`}>
      <td><strong>{quote.symbol}</strong></td>
      {children}
      <td className="price-cell">{formatPrice(quote.price)}</td>
    </tr>
  );
}

function mtfTriggerTime(matches) {
  const match = (matches || []).find((item) => item.candle_time);
  if (!match) return "-";
  const parsed = new Date(match.candle_time);
  if (Number.isNaN(parsed.getTime())) return String(match.candle_time);
  return parsed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
