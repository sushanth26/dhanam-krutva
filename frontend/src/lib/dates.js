export const MARKET_TIMEZONE = "America/New_York";

export function formatDateTime(value) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  const date = parsed.toLocaleDateString([], { month: "short", day: "numeric", timeZone: MARKET_TIMEZONE });
  const time = formatMarketTime(parsed);
  return `${date} ${time}`;
}

export function formatMarketTime(value) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    timeZone: MARKET_TIMEZONE,
    timeZoneName: "shortGeneric",
  });
}
