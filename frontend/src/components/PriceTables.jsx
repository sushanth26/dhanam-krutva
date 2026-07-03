import { useMemo, useState } from "react";

import { CloudTag, MtfTag } from "./Tags";
import { cloudStatus, emaTooltip, formatPrice, groupBySector, sectorSlug } from "../lib/market";

const DEFAULT_SORT = { key: "symbol", direction: "asc" };

export function MtfTable({ quotes }) {
  const [sort, setSort] = useState(DEFAULT_SORT);
  const sortedQuotes = useMemo(() => sortQuotes(quotes, sort, "mtf"), [quotes, sort]);

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
              <SortableHeader label="Symbol" sortKey="symbol" sort={sort} onSort={setSort} />
              <SortableHeader label="On EMA" sortKey="mtf" sort={sort} onSort={setSort} />
              <SortableHeader label="Last" sortKey="price" sort={sort} onSort={setSort} className="price-col" />
            </tr>
          </thead>
          <tbody>
            {sortedQuotes.length ? sortedQuotes.map((quote) => <MtfRow key={quote.symbol} quote={quote} />) : (
              <tr><td colSpan="3">No stocks are on hourly or daily EMA clouds right now.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function PriceBucket({ title, quotes, kind }) {
  const [sort, setSort] = useState(DEFAULT_SORT);
  const sortedQuotes = useMemo(() => sortQuotes(quotes, sort, "trend"), [quotes, sort]);
  const grouped = groupBySector(sortedQuotes);
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
              <SortableHeader label="Symbol" sortKey="symbol" sort={sort} onSort={setSort} />
              <SortableHeader label="Trend - 10m 5/12 vs 34/50" sortKey="trend" sort={sort} onSort={setSort} />
              <SortableHeader label="Last" sortKey="price" sort={sort} onSort={setSort} className="price-col" />
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
    </tr>
  );
}

function SortableHeader({ label, sortKey, sort, onSort, className = "" }) {
  const active = sort.key === sortKey;
  const direction = active ? sort.direction : "none";
  return (
    <th className={className}>
      <button
        className={`sort-button ${active ? "active" : ""}`}
        type="button"
        aria-sort={direction === "none" ? "none" : direction === "asc" ? "ascending" : "descending"}
        onClick={() => onSort(nextSort(sort, sortKey))}
      >
        <span>{label}</span>
        <b>{active ? (sort.direction === "asc" ? "Asc" : "Desc") : "Sort"}</b>
      </button>
    </th>
  );
}

function nextSort(current, key) {
  if (current.key !== key) return { key, direction: "asc" };
  return { key, direction: current.direction === "asc" ? "desc" : "asc" };
}

function sortQuotes(quotes, sort, mode) {
  const direction = sort.direction === "asc" ? 1 : -1;
  return [...quotes].sort((a, b) => {
    const result = compareValues(sortValue(a, sort.key, mode), sortValue(b, sort.key, mode));
    if (result !== 0) return result * direction;
    return String(a.symbol).localeCompare(String(b.symbol));
  });
}

function sortValue(quote, key, mode) {
  if (key === "price") return Number(quote.price);
  if (key === "trend") return cloudStatus(quote.ema_10m, ["5", "12"], ["34", "50"]);
  if (key === "mtf") return (quote.mtf_matches || []).map((match) => match.label).join(" + ");
  if (mode === "mtf" && key === "symbol") return quote.symbol;
  return quote.symbol;
}

function compareValues(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }
  return String(left || "").localeCompare(String(right || ""));
}
