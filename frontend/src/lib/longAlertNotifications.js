import { formatPrice } from "./market";

export function longAlertSignature(rows) {
  return rows
    .map((row) => `${row.symbol}:${row.match.type}:${row.match.display_label}:${row.match.candle_time}:${row.match.mtf_label || row.match.cloud_label || ""}`)
    .sort()
    .join(",");
}

export function longAlertNotification(rows) {
  const first = rows[0];
  const title = rows.length === 1
    ? `${first.symbol}: ${setupName(first.match)} alert`
    : `${rows.length} Setup alerts`;
  const message = rows.length === 1
    ? setupMessage(first.match)
    : rows.slice(0, 3).map((row) => `${row.symbol} ${setupName(row.match)}`).join(" | ");
  return { title, message };
}

function setupName(match) {
  if (match.type === "10m_34_50_bounce") return "10m 34/50 Bounce";
  return "Curl";
}

function setupMessage(match) {
  if (match.type === "10m_34_50_bounce") {
    return `Confirmed above 10m 34/50 at ${formatPrice(match.entry_price)}`;
  }
  return `${match.mtf_label} -> above 10m 5/12 at ${formatPrice(match.entry_price)}`;
}
