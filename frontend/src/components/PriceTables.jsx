import { CloudTag } from "./Tags";
import { cloudStatus, formatPrice } from "../lib/market";

export function PriceBucket({ title, quotes, kind, onRemoveSymbol }) {
  const sortedQuotes = [...quotes].sort(compareMtfProximity);
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
              <th className="mtf-col">MTF</th>
              <th className="price-col">Last</th>
              {onRemoveSymbol ? <th className="action-col" aria-label="Actions"></th> : null}
            </tr>
          </thead>
          <tbody>
            {sortedQuotes.length ? sortedQuotes.map((quote) => (
              <PriceRow key={quote.symbol} quote={quote} onRemoveSymbol={onRemoveSymbol} />
            )) : (
              <tr><td colSpan={onRemoveSymbol ? "5" : "4"}>No {kind} stocks right now.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PriceRow({ quote, onRemoveSymbol }) {
  const tenMinuteStatus = cloudStatus(quote.ema_10m, ["5", "12"], ["34", "50"]);
  return (
    <BaseRow quote={quote} trend={tenMinuteStatus} action={onRemoveSymbol ? <RemoveCell onRemove={() => onRemoveSymbol(quote.symbol)} symbol={quote.symbol} /> : null}>
      <td><CloudTag status={tenMinuteStatus} /></td>
      <td className="mtf-cell"><MtfCloudMiniMap quote={quote} /></td>
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

function MtfCloudMiniMap({ quote }) {
  const proximity = quote.mtf_proximity?.nearest;
  const clouds = proximity ? [mtfCloudFromProximity(proximity)] : mtfCloudsForQuote(quote);
  if (!clouds.length) return <span className="mtf-empty">-</span>;

  const visibleClouds = clouds.slice(0, 2);
  const extraCount = clouds.length - visibleClouds.length;
  return (
    <div className="mtf-mini-map" title={clouds.map(cloudTitle).join("\n")} aria-label={clouds.map(cloudTitle).join(", ")}>
      {visibleClouds.map((cloud) => (
        <span
          className={`mtf-mini-chip ${cloud.kind} ${cloud.status || ""}`}
          key={`${cloud.label}-${cloud.low}-${cloud.high}`}
          style={cloud.kind === "radar" ? mtfRadarStyle(cloud) : undefined}
        >
          <b>{shortMtfLabel(cloud.label)} {directionSymbol(cloud.direction)}</b>
          <small>{cloud.rangeRatio == null ? `${formatPrice(cloud.low)}-${formatPrice(cloud.high)}` : `${formatRangeRatio(cloud.rangeRatio)}R`}</small>
        </span>
      ))}
      {extraCount > 0 ? <span className="mtf-mini-more">+{extraCount}</span> : null}
    </div>
  );
}

function mtfCloudFromProximity(proximity) {
  return {
    label: proximity.label,
    low: proximity.cloud_low,
    high: proximity.cloud_high,
    kind: "radar",
    direction: proximity.direction,
    distance: proximity.distance,
    distancePct: proximity.distance_pct,
    rangeRatio: proximity.range_ratio,
    status: proximity.status,
  };
}

function mtfCloudsForQuote(quote) {
  const seen = new Set();
  return (quote.mtf_matches || []).flatMap(mtfCloudsForMatch).filter((cloud) => {
    const key = `${cloud.label}-${cloud.low}-${cloud.high}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mtfCloudsForMatch(match) {
  if (Array.isArray(match.mtf_touches) && match.mtf_touches.length) {
    return match.mtf_touches.map((touch) => ({
      label: touch.label,
      low: touch.cloud_low,
      high: touch.cloud_high,
      kind: "curl",
    }));
  }
  const label = match.cloud_label || match.mtf_label;
  const low = match.mtf_cloud_low ?? match.cloud_low;
  const high = match.mtf_cloud_high ?? match.cloud_high;
  if (!label || low == null || high == null) return [];
  return [{ label, low, high, kind: match.type === "mtf_cloud_price_touch" ? "touch" : "setup" }];
}

function cloudTitle(cloud) {
  const rangeRatio = cloud.rangeRatio == null ? "" : ` | ${formatRangeRatio(cloud.rangeRatio)}R`;
  const distance = cloud.distance == null ? "" : ` | ${formatPrice(cloud.distance)} away`;
  return `${cloud.label}: ${formatPrice(cloud.low)}-${formatPrice(cloud.high)}${distance}${rangeRatio}`;
}

function shortMtfLabel(label = "") {
  return String(label)
    .replace(/^Hourly\s+/i, "H ")
    .replace(/^Daily\s+/i, "D ")
    .replace(/\s+/g, " ")
    .trim();
}

function directionSymbol(direction) {
  if (direction === "above") return "↑";
  if (direction === "below") return "↓";
  if (direction === "inside") return "•";
  return "";
}

function formatRangeRatio(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "-";
  return parsed.toFixed(2);
}

function compareMtfProximity(left, right) {
  const leftScore = mtfSortScore(left);
  const rightScore = mtfSortScore(right);
  if (leftScore !== rightScore) return leftScore - rightScore;
  return String(left.symbol || "").localeCompare(String(right.symbol || ""));
}

function mtfSortScore(quote) {
  const nearest = quote.mtf_proximity?.nearest;
  if (!nearest) return Number.POSITIVE_INFINITY;
  if (nearest.status === "inside") return -1;
  const ratio = Number(nearest.range_ratio);
  if (Number.isFinite(ratio)) return ratio;
  const distance = Number(nearest.distance);
  return Number.isFinite(distance) ? 1000 + distance : Number.POSITIVE_INFINITY;
}

function mtfRadarStyle(cloud) {
  const ratio = Number(cloud.rangeRatio);
  const progress = Number.isFinite(ratio) ? Math.min(Math.max(ratio, 0), 1) : 1;
  const background = mixRgb([7, 87, 71], [238, 242, 245], progress);
  const border = mixRgb([5, 70, 57], [207, 216, 204], progress);
  const text = progress < 0.42 ? "#ffffff" : "#184d36";
  return {
    "--mtf-chip-bg": background,
    "--mtf-chip-border": border,
    "--mtf-chip-text": text,
  };
}

function mixRgb(start, end, progress) {
  const values = start.map((value, index) => Math.round(value + (end[index] - value) * progress));
  return `rgb(${values.join(", ")})`;
}
