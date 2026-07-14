import { cloudStatus, formatPrice } from "../lib/market";

const LIVE_LONG_SETUP_TYPES = new Set(["long_mtf_5_12_touch", "10m_34_50_bounce"]);
const TOUCH_ALERT_TYPES = new Set(["mtf_cloud_price_touch"]);

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
              <th className="mtf-col">Read</th>
              <th className="rr-col">R:R</th>
              <th className="qty-col">Qty</th>
              <th className="trade-level-col">Entry</th>
              <th className="trade-level-col">TP1</th>
              <th className="price-col">Last</th>
              {onRemoveSymbol ? <th className="action-col" aria-label="Actions"></th> : null}
            </tr>
          </thead>
          <tbody>
            {sortedQuotes.length ? sortedQuotes.map((quote) => (
              <PriceRow key={quote.symbol} quote={quote} onRemoveSymbol={onRemoveSymbol} />
            )) : (
              <tr><td colSpan={onRemoveSymbol ? "8" : "7"}>No {kind} stocks right now.</td></tr>
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
      <td className="mtf-cell"><ScannerDecision quote={quote} trend={tenMinuteStatus} /></td>
      <td className="rr-cell"><RewardRisk quote={quote} /></td>
      <td className="qty-cell"><TradeQuantity quote={quote} /></td>
      <td className="trade-level-cell"><TradeLevel quote={quote} field="entry" /></td>
      <td className="trade-level-cell"><TradeLevel quote={quote} field="tp1" /></td>
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

function ScannerDecision({ quote, trend }) {
  const thesis = quote.trade_thesis;
  const decision = thesis ? thesisDecision(thesis) : quote.scanner_read || scannerDecision(quote, trend);
  const clouds = scannerCloudsForQuote(quote);
  const detail = [
    thesis ? tradeThesisTitle(thesis) : "",
    decision.detail,
    clouds.length ? clouds.map(cloudTitle).join("\n") : "",
  ].filter(Boolean).join("\n\n");

  return (
    <span className={`scanner-decision ${decision.kind}`} title={detail} aria-label={detail || `${decision.label}: ${decision.reason}`}>
      <b>{decision.label}</b>
      <small>{decision.reason}</small>
    </span>
  );
}

function thesisDecision(thesis) {
  const decision = String(thesis.decision || "Skip");
  return {
    kind: decision.toLowerCase(),
    label: decision,
    reason: thesis.reason || "-",
    detail: thesis.detail || "",
  };
}

function tradeThesisTitle(thesis) {
  const lines = [
    `${thesis.decision || "Decision"}: ${thesis.reason || ""}`,
    `Setup: ${gateText(thesis.setup)}`,
    `Confirmation: ${gateText(thesis.confirmation)}`,
    `R:R: ${gateText(thesis.reward_risk)}`,
    Number.isFinite(Number(thesis.entry)) ? `Entry: ${formatPrice(thesis.entry)}` : "",
    Number.isFinite(Number(thesis.invalidation)) ? `Invalidation: ${formatPrice(thesis.invalidation)}` : "",
    ...(thesis.targets || []).slice(0, 3).map((target, index) => (
      `T${index + 1}: ${formatPrice(target.price)}${Number.isFinite(Number(target.reward_risk)) ? ` = ${Number(target.reward_risk).toFixed(2)}R` : ""}`
    )),
  ];
  return lines.filter(Boolean).join("\n");
}

function gateText(gate) {
  if (!gate) return "-";
  return `${gate.status ? "Yes" : "No"} - ${gate.label || ""}`;
}

function RewardRisk({ quote }) {
  const plan = quote.trade_plan;
  if (!plan) return <span className="rr-chip rr-empty">-</span>;
  const target = bestRewardRiskTarget(plan);
  const rr = Number(target?.reward_risk ?? plan.reward_risk);
  const detail = tradePlanTitle(plan);
  const label = Number.isFinite(rr) ? `${rr.toFixed(2)}R` : "Plan";
  const reason = Number.isFinite(rr) ? rewardRiskReason(plan) : "needs S/R";
  return (
    <span className={`rr-chip ${target?.grade || plan.grade || "incomplete"}`} title={detail} aria-label={detail}>
      <b>{label}</b>
      <small>{reason}</small>
    </span>
  );
}

function TradeQuantity({ quote }) {
  if (!isPlayableQuote(quote)) return <span className="trade-mini-empty">-</span>;
  const shares = Number(quote.trade_plan?.risk_plan?.shares);
  if (!Number.isFinite(shares) || shares <= 0) return <span className="trade-mini-empty">-</span>;
  return <span className="trade-mini-value" title={`${shares} shares`}>{shares}</span>;
}

function TradeLevel({ quote, field }) {
  if (!isPlayableQuote(quote)) return <span className="trade-mini-empty">-</span>;
  const plan = quote.trade_plan;
  const target = firstTradeTarget(plan);
  const value = field === "entry" ? plan?.entry : target?.price ?? plan?.target;
  if (!Number.isFinite(Number(value))) return <span className="trade-mini-empty">-</span>;
  const title = field === "entry"
    ? tradePlanTitle(plan)
    : `${target?.label || "TP1"}: ${formatPrice(value)}${Number.isFinite(Number(target?.reward_risk)) ? ` = ${Number(target.reward_risk).toFixed(2)}R` : ""}`;
  return <span className="trade-mini-value" title={title}>{formatPrice(value)}</span>;
}

function isPlayableQuote(quote) {
  return String(quote.trade_thesis?.decision || "").toLowerCase() === "playable";
}

function tradePlanTitle(plan) {
  const lines = [
    `${plan.action || "Trade"} plan`,
    Number.isFinite(Number(plan.entry)) ? `Entry: ${formatPrice(plan.entry)}` : "",
    Number.isFinite(Number(plan.stop)) ? `Stop: ${formatPrice(plan.stop)} (${plan.stop_level?.label || "support/resistance"})` : "",
    Number.isFinite(Number(plan.target)) ? `Target: ${formatPrice(plan.target)} (${plan.target_level?.label || "support/resistance"})` : "",
    Number.isFinite(Number(plan.risk_per_share)) ? `Risk/share: ${formatPrice(plan.risk_per_share)}` : "",
    Number.isFinite(Number(plan.reward_per_share)) ? `Reward/share: ${formatPrice(plan.reward_per_share)}` : "",
    Number.isFinite(Number(plan.reward_risk)) ? `Reward:risk: ${Number(plan.reward_risk).toFixed(2)}R` : "Needs both stop and target levels.",
    ...(plan.targets || []).slice(0, 3).map((target, index) => (
      `T${index + 1}: ${formatPrice(target.price)} = ${Number(target.reward_risk).toFixed(2)}R (${target.label || "target"})`
    )),
  ];
  return lines.filter(Boolean).join("\n");
}

function rewardRiskReason(plan) {
  if (plan.has_acceptable_target || plan.is_acceptable) return plan.grade === "excellent" ? "great room" : "good room";
  if (plan.grade === "thin") return "thin";
  return "skip";
}

function bestRewardRiskTarget(plan) {
  const targets = plan.targets || [];
  return targets.find((target) => target.is_acceptable) || targets[0] || null;
}

function firstTradeTarget(plan) {
  return (plan?.targets || [])[0] || null;
}

function scannerDecision(quote, trend) {
  const matches = quote.mtf_matches || [];
  if (!["Bullish", "Bearish"].includes(trend)) {
    return {
      kind: "skip",
      label: "Skip",
      reason: `${trend || "No"} trend`,
      detail: "Scanner waits for a bullish or bearish 10m trend.",
    };
  }
  if (trend === "Bearish") return bearishScannerDecision(quote);

  const entryMatches = matches.filter((match) => match.trade_action === "Long" && LIVE_LONG_SETUP_TYPES.has(match.type));
  const goodEntryMatch = entryMatches.find((match) => match.setup_quality !== "bad");
  const badBounce = entryMatches.find((match) => match.type === "10m_34_50_bounce" && match.setup_quality === "bad");
  const touchMatch = matches.find((match) => TOUCH_ALERT_TYPES.has(match.type));
  const entryCloud = entryCloudDistance(quote);
  const resistance = nearestMtfResistance(quote);
  const support = nearestMtfSupport(quote);

  if (resistance?.direction === "inside") {
    return {
      kind: "wait",
      label: "Wait",
      reason: `clear ${shortMtfLabel(resistance.label)}`,
      detail: "Price is inside an MTF cloud. Treat it as resistance until price clears above it.",
    };
  }

  if (resistance) {
    return {
      kind: "wait",
      label: "Wait",
      reason: `break ${shortMtfLabel(resistance.label)}`,
      detail: "Nearest MTF cloud is still overhead resistance. A clean move above it makes the read more bullish.",
    };
  }

  if (badBounce && !goodEntryMatch) {
    return {
      kind: "skip",
      label: "Skip",
      reason: "weak bounce",
      detail: badBounce.setup_quality_note || "The 10m 34/50 bounce is marked low quality.",
    };
  }

  if (!entryCloud) {
    return {
      kind: "wait",
      label: "Wait",
      reason: "need 5/12",
      detail: "The scanner needs the 10m 5/12 EMA cloud to judge the entry.",
    };
  }

  if (entryCloud.status === "extended") {
    return {
      kind: "wait",
      label: "Wait",
      reason: "pullback 5/12",
      detail: support
        ? `Price is above MTF clouds and ${shortMtfLabel(support.label)} is acting as support, but entry should wait for the 10m 5/12 EMA cloud.`
        : "Price is bullish but extended above the 10m 5/12 EMA cloud. Wait for the entry pullback.",
    };
  }

  if (entryCloud.status === "below") {
    return {
      kind: "wait",
      label: "Wait",
      reason: "reclaim 5/12",
      detail: "Price is below the 10m 5/12 EMA cloud. Wait for reclaim before considering a long entry.",
    };
  }

  if (goodEntryMatch) {
    return {
      kind: "entry",
      label: "Entry",
      reason: "in 5/12",
      detail: support
        ? `${displayMatchName(goodEntryMatch)} with price inside the 10m 5/12 EMA cloud. MTF cloud below is support.`
        : `${displayMatchName(goodEntryMatch)} with price inside the 10m 5/12 EMA cloud.`,
    };
  }

  if (touchMatch) {
    return {
      kind: "wait",
      label: "Wait",
      reason: "5/12 trigger",
      detail: "Price has cleared MTF resistance, but wait for the 10m 5/12 EMA cloud entry trigger.",
    };
  }

  return {
    kind: "wait",
    label: "Wait",
    reason: "in 5/12, no trigger",
    detail: "Price is inside the 10m 5/12 EMA cloud, but no curl or quality 10m bounce trigger is active.",
  };
}

function bearishScannerDecision(quote) {
  const matches = quote.mtf_matches || [];
  const entryMatches = matches.filter((match) => match.trade_action === "Short" && LIVE_LONG_SETUP_TYPES.has(match.type));
  const goodEntryMatch = entryMatches.find((match) => match.setup_quality !== "bad");
  const badBounce = entryMatches.find((match) => match.type === "10m_34_50_bounce" && match.setup_quality === "bad");
  const touchMatch = matches.find((match) => TOUCH_ALERT_TYPES.has(match.type));
  const entryCloud = entryCloudDistance(quote);
  const resistance = nearestMtfResistance(quote);
  const support = nearestMtfSupport(quote);

  if (support?.direction === "inside") {
    return {
      kind: "wait",
      label: "Wait",
      reason: `break ${shortMtfLabel(support.label)}`,
      detail: "Price is inside an MTF cloud. Treat it as support until price breaks below it.",
    };
  }

  if (support && Number(support.distancePct) <= 1.5) {
    return {
      kind: "wait",
      label: "Wait",
      reason: `break ${shortMtfLabel(support.label)}`,
      detail: "Nearest MTF cloud is still underfoot support. A clean move below it makes the read more bearish.",
    };
  }

  if (badBounce && !goodEntryMatch) {
    return {
      kind: "skip",
      label: "Skip",
      reason: "weak rejection",
      detail: badBounce.setup_quality_note || "The 10m 34/50 rejection is marked low quality.",
    };
  }

  if (!entryCloud) {
    return {
      kind: "wait",
      label: "Wait",
      reason: "need 5/12",
      detail: "The scanner needs the 10m 5/12 EMA cloud to judge the short entry.",
    };
  }

  if (entryCloud.status === "below") {
    return {
      kind: "wait",
      label: "Wait",
      reason: "pullback 5/12",
      detail: resistance
        ? `Price is below MTF support and ${shortMtfLabel(resistance.label)} is overhead resistance, but entry should wait for the 10m 5/12 EMA cloud.`
        : "Price is bearish but extended below the 10m 5/12 EMA cloud. Wait for the entry pullback.",
    };
  }

  if (entryCloud.status === "extended") {
    return {
      kind: "wait",
      label: "Wait",
      reason: "reject 5/12",
      detail: "Price is above the 10m 5/12 EMA cloud. Wait for rejection back into the short entry zone.",
    };
  }

  if (goodEntryMatch) {
    return {
      kind: "entry",
      label: "Entry",
      reason: "in 5/12",
      detail: resistance
        ? `${displayMatchName(goodEntryMatch)} with price inside the 10m 5/12 EMA cloud. MTF cloud above is resistance.`
        : `${displayMatchName(goodEntryMatch)} with price inside the 10m 5/12 EMA cloud.`,
    };
  }

  if (touchMatch) {
    return {
      kind: "wait",
      label: "Wait",
      reason: "5/12 trigger",
      detail: "Price has broken MTF support, but wait for the 10m 5/12 EMA cloud short entry trigger.",
    };
  }

  return {
    kind: "wait",
    label: "Wait",
    reason: "in 5/12, no trigger",
    detail: "Price is inside the 10m 5/12 EMA cloud, but no quality 10m rejection trigger is active.",
  };
}

function entryCloudDistance(quote) {
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
    status: distance <= 0 ? "entry" : direction === "below" ? "extended" : "below",
  };
}

function nearestMtfResistance(quote) {
  const price = Number(quote.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  return scannerCloudsForQuote(quote)
    .filter(isMtfCloud)
    .filter((cloud) => cloud.direction === "above" || cloud.direction === "inside")
    .map((cloud) => ({
      ...cloud,
      distancePct: cloud.direction === "inside" ? 0 : normalizedCloudDistancePct(cloud, price),
    }))
    .filter((cloud) => Number.isFinite(cloud.distancePct) && cloud.distancePct <= 1.5)
    .sort((left, right) => left.distancePct - right.distancePct)[0] || null;
}

function nearestMtfSupport(quote) {
  const price = Number(quote.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  return scannerCloudsForQuote(quote)
    .filter(isMtfCloud)
    .filter((cloud) => cloud.direction === "below" || cloud.direction === "inside")
    .map((cloud) => ({
      ...cloud,
      distancePct: cloud.direction === "inside" ? 0 : normalizedCloudDistancePct(cloud, price),
    }))
    .filter((cloud) => Number.isFinite(cloud.distancePct))
    .sort((left, right) => left.distancePct - right.distancePct)[0] || null;
}

function isMtfCloud(cloud) {
  return cloud.label !== "10m 34/50";
}

function normalizedCloudDistancePct(cloud, price) {
  const direct = Number(cloud.distancePct);
  if (Number.isFinite(direct)) return direct;
  const low = Number(cloud.low);
  const high = Number(cloud.high);
  if (![low, high].every(Number.isFinite) || price <= 0) return Number.NaN;
  const distance = price < low ? low - price : price > high ? price - high : 0;
  return distance / price * 100;
}

function displayMatchName(match) {
  if (match.type === "long_mtf_5_12_touch") return "curl";
  if (match.type === "10m_34_50_bounce") return "10m bounce";
  return String(match.display_label || match.label || "setup").toLowerCase();
}

function scannerCloudsForQuote(quote) {
  const clouds = [
    tenMinuteSlowCloud(quote),
    ...(quote.mtf_proximity?.clouds || []).map(mtfCloudFromProximity),
    ...mtfCloudsForQuote(quote),
  ].filter(Boolean);
  const seen = new Set();
  return clouds.filter((cloud) => {
    const key = `${cloud.label}-${cloud.low}-${cloud.high}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function tenMinuteSlowCloud(quote) {
  const price = Number(quote.price);
  const ema34 = Number(quote.ema_10m?.["34"]);
  const ema50 = Number(quote.ema_10m?.["50"]);
  if (![price, ema34, ema50].every(Number.isFinite) || price <= 0) return null;
  const low = Math.min(ema34, ema50);
  const high = Math.max(ema34, ema50);
  const [distance, direction] = distanceToRange(price, low, high);
  const distancePct = distance / price * 100;
  return {
    label: "10m 34/50",
    low,
    high,
    kind: "radar",
    direction,
    distance,
    distancePct,
    rangeRatio: null,
    status: scannerCloudStatus(distance, distancePct),
  };
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

function scannerCloudStatus(distance, distancePct) {
  if (distance <= 0) return "inside";
  if (distancePct <= 0.25) return "hot";
  if (distancePct <= 0.75) return "near";
  if (distancePct <= 1.5) return "reachable";
  return "far";
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
  const leftPlanScore = tradePlanSortScore(left);
  const rightPlanScore = tradePlanSortScore(right);
  if (leftPlanScore !== rightPlanScore) return leftPlanScore - rightPlanScore;
  const leftScore = fastEmaSortScore(left);
  const rightScore = fastEmaSortScore(right);
  if (leftScore !== rightScore) return leftScore - rightScore;
  return compareMtfProximity(left, right);
}

function tradePlanSortScore(quote) {
  const plan = quote.trade_plan;
  const rr = Number(bestRewardRiskTarget(plan || {})?.reward_risk ?? plan?.reward_risk);
  if (!Number.isFinite(rr)) return Number.POSITIVE_INFINITY;
  const decision = String(quote.trade_thesis?.decision || "").toLowerCase();
  const kindBonus = decision === "playable" ? 0 : decision === "wait" ? 10 : quote.scanner_read?.kind === "entry" ? 2 : 20;
  return kindBonus - rr;
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
