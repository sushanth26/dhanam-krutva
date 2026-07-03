import { CloudTag, MtfTag } from "./Tags";
import { cloudStatus, emaTooltip, formatPercent, formatPrice, groupBySector, sectorSlug } from "../lib/market";

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
              <th className="price-col">Last</th>
              <th className="change-col">Change</th>
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
              <th>10m 5/12 vs 34/50</th>
              <th className="price-col">Last</th>
              <th className="change-col">Change</th>
            </tr>
          </thead>
          <tbody>
            {quotes.length ? Object.entries(grouped).map(([sector, sectorQuotes]) => (
              <SectorRows key={sector} sector={sector} quotes={sectorQuotes} />
            )) : (
              <tr><td colSpan="4">No {kind} stocks right now.</td></tr>
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
        <td colSpan="4">{sector}</td>
      </tr>
      {quotes.map((quote) => <PriceRow key={quote.symbol} quote={quote} />)}
    </>
  );
}

function MtfRow({ quote }) {
  return (
    <BaseRow quote={quote}>
      <td className="mtf-tags">
        {quote.mtf_matches.map((match) => <MtfTag key={match.label} label={match.label} />)}
      </td>
    </BaseRow>
  );
}

function PriceRow({ quote }) {
  const tenMinuteStatus = cloudStatus(quote.ema_10m, ["5", "12"], ["34", "50"]);
  return (
    <BaseRow quote={quote}>
      <td><CloudTag status={tenMinuteStatus} /></td>
    </BaseRow>
  );
}

function BaseRow({ quote, children }) {
  const change = Number(quote.change);
  const rowClass = Number.isFinite(change) ? (change < 0 ? "day-red" : change > 0 ? "day-green" : "") : "";
  const tooltip = emaTooltip(quote);
  return (
    <tr className={`stock-row ${rowClass}`} title={tooltip} data-ema-tooltip={tooltip}>
      <td><strong>{quote.symbol}</strong></td>
      {children}
      <td className="price-cell">{formatPrice(quote.price)}</td>
      <td className="change-cell">
        {formatPrice(quote.change)} <span className="quote-size">{formatPercent(quote.change_ratio)}</span>
      </td>
    </tr>
  );
}
