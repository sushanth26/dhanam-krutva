import { cloudStatus, formatPrice } from "../lib/market";

export function PriceBucket({ title, quotes, kind, onRemoveSymbol }) {
  const sortedQuotes = [...quotes].sort(compareTenMinuteFastCloud);
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
              <th className="fast-ema-col">10m 5/12</th>
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
      <td className="fast-ema-cell"><FastEmaDistance quote={quote} /></td>
      <td className="mtf-cell"><MtfCloudMiniMap quote={quote} trend={tenMinuteStatus} /></td>
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

function FastEmaDistance({ quote }) {
  const distance = fastEmaDistance(quote);
  if (!distance) return <span className="mtf-empty">-</span>;
  return (
    <span
      className={`fast-ema-chip ${distance.status}`}
      title={`10m 5/12: ${formatPrice(distance.low)}-${formatPrice(distance.high)} | ${formatPrice(distance.distance)} away`}
      style={fastEmaStyle(distance)}
    >
      <b>5/12 {directionSymbol(distance.direction)}</b>
      <small>{formatPercent(distance.distancePct)}</small>
    </span>
  );
}

function MtfCloudMiniMap({ quote, trend }) {
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
          style={cloud.kind === "radar" ? mtfRadarStyle(cloud, trend) : undefined}
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

function compareTenMinuteFastCloud(left, right) {
  const leftScore = fastEmaSortScore(left);
  const rightScore = fastEmaSortScore(right);
  if (leftScore !== rightScore) return leftScore - rightScore;
  return compareMtfProximity(left, right);
}

function fastEmaSortScore(quote) {
  const distance = fastEmaDistance(quote);
  if (!distance) return Number.POSITIVE_INFINITY;
  return distance.distancePct;
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

function fastEmaDistance(quote) {
  const price = Number(quote.price);
  const ema5 = Number(quote.ema_10m?.["5"]);
  const ema12 = Number(quote.ema_10m?.["12"]);
  if (![price, ema5, ema12].every(Number.isFinite) || price <= 0) return null;
  const low = Math.min(ema5, ema12);
  const high = Math.max(ema5, ema12);
  const [distance, direction] = distanceToRange(price, low, high);
  const distancePct = distance / price * 100;
  return {
    low,
    high,
    distance,
    distancePct,
    direction,
    status: distance <= 0 ? "inside" : "nearby",
  };
}

function distanceToRange(price, low, high) {
  if (low <= price && price <= high) return [0, "inside"];
  if (price < low) return [low - price, "above"];
  return [price - high, "below"];
}

function fastEmaStyle(distance) {
  const progress = Math.min(Math.max(distance.distancePct / 2, 0), 1);
  const background = mixRgb([7, 87, 71], [238, 242, 245], progress);
  const border = mixRgb([5, 70, 57], [207, 216, 204], progress);
  const text = progress < 0.42 ? "#ffffff" : "#184d36";
  return {
    "--fast-ema-bg": background,
    "--fast-ema-border": border,
    "--fast-ema-text": text,
  };
}

function mtfRadarStyle(cloud, trend) {
  const ratio = Number(cloud.rangeRatio);
  const progress = Number.isFinite(ratio) ? Math.min(Math.max(ratio, 0), 1) : 1;
  const palette = mtfRadarPalette(cloud.direction, trend);
  const background = mixRgb(palette.start, [238, 242, 245], progress);
  const border = mixRgb(palette.border, [207, 216, 204], progress);
  const text = progress < palette.lightTextUntil ? "#ffffff" : palette.text;
  return {
    "--mtf-chip-bg": background,
    "--mtf-chip-border": border,
    "--mtf-chip-text": text,
  };
}

function mtfRadarPalette(direction, trend) {
  if (direction === "inside") {
    return {
      start: [20, 101, 113],
      border: [15, 81, 91],
      text: "#184d36",
      lightTextUntil: 0.48,
    };
  }

  const isBullish = trend === "Bullish";
  const isBearish = trend === "Bearish";
  const isTrendBarrier = (isBullish && direction === "above") || (isBearish && direction === "below");
  if (isTrendBarrier) {
    return {
      start: [164, 92, 24],
      border: [134, 72, 16],
      text: "#5a4211",
      lightTextUntil: 0.42,
    };
  }

  const isTrendSupport = (isBullish && direction === "below") || (isBearish && direction === "above");
  if (isTrendSupport) {
    return {
      start: [7, 87, 71],
      border: [5, 70, 57],
      text: "#184d36",
      lightTextUntil: 0.42,
    };
  }

  return {
    start: [66, 90, 112],
    border: [54, 73, 91],
    text: "#34404c",
    lightTextUntil: 0.42,
  };
}

function mixRgb(start, end, progress) {
  const values = start.map((value, index) => Math.round(value + (end[index] - value) * progress));
  return `rgb(${values.join(", ")})`;
}

function formatPercent(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "-";
  return `${parsed.toFixed(2)}%`;
}
