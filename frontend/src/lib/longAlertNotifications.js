import { formatPrice } from "./market.js";

export function longAlertSignature(rows) {
  return rows
    .map((row) => `${rowSymbol(row)}:${row.match.type}:${row.match.display_label}:${row.match.candle_time}:${row.match.mtf_label || row.match.cloud_label || ""}`)
    .sort()
    .join(",");
}

export function longAlertNotification(rows) {
  const first = rows[0];
  const title = rows.length === 1
    ? `${rowSymbol(first)}: ${setupName(first.match)} alert`
    : `${rows.length} Setup alerts`;
  const message = rows.length === 1
    ? setupMessage(first.match)
    : rows.slice(0, 3).map((row) => `${rowSymbol(row)} ${setupName(row.match)} at ${formatPrice(row.match.entry_price)}`).join(" | ");
  return { title, message };
}

function rowSymbol(row) {
  return row.quote?.symbol || row.symbol || "Unknown";
}

function setupName(match) {
  if (match.type === "10m_34_50_bounce" || match.type === "10m_cloud_bounce") {
    return cleanSetupLabel(match.display_label || match.label || "10m 34/50 Bounce");
  }
  if (match.type === "mtf_cloud_price_touch") return `${touchLabel(match)} Touch`;
  return "Curl";
}

function setupMessage(match) {
  if (match.type === "10m_34_50_bounce" || match.type === "10m_cloud_bounce") {
    return `${cleanSetupLabel(match.display_label || match.label || "10m 34/50 Bounce")} at ${formatPrice(match.entry_price)}`;
  }
  if (match.type === "mtf_cloud_price_touch") {
    const action = match.direction === "reject_down" ? "rejected down from" : "bounced up from";
    return `Price ${action} ${touchLabel(match)} at ${formatPrice(match.entry_price)}`;
  }
  const triggerLabel = curlTriggerLabel(match);
  return `${triggerLabel} -> above 10m 5/12 at ${formatPrice(match.entry_price)}`;
}

function curlTriggerLabel(match) {
  if (match.mtf_label || match.cloud_label) return match.mtf_label || match.cloud_label;
  const displayLabel = String(match.display_label || "");
  const curlPrefix = displayLabel.match(/^Curl:\s*(.*?)\s*->/i);
  if (curlPrefix?.[1]) return curlPrefix[1];
  return match.label || "MTF setup";
}

function cleanSetupLabel(label) {
  return String(label)
    .replace(/^10m bounce\s+/i, "")
    .replace(/\s+Touch$/i, "")
    .trim() || "10m 34/50 Bounce";
}

function touchLabel(match) {
  return match.cloud_label || match.mtf_label || match.display_label || match.label || "MTF cloud";
}
