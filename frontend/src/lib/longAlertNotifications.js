import { formatPrice } from "./market";

export function longAlertSignature(rows) {
  return rows
    .map((row) => `${row.symbol}:${row.match.display_label}:${row.match.candle_time}:${row.match.mtf_label}`)
    .sort()
    .join(",");
}

export function longAlertNotification(rows) {
  const first = rows[0];
  const title = rows.length === 1
    ? `${first.symbol}: Curl alert`
    : `${rows.length} Curl alerts`;
  const message = rows.length === 1
    ? `${first.match.mtf_label} -> above 10m 5/12 at ${formatPrice(first.match.entry_price)}`
    : rows.slice(0, 3).map((row) => `${row.symbol} ${row.match.mtf_label}`).join(" | ");
  return { title, message };
}
