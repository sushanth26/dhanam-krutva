export function CloudTag({ status }) {
  const normalized = ["Bullish", "Bearish", "Chop", "Waiting"].includes(status) ? String(status).toLowerCase() : "unknown";
  return <span className={`cloud-tag ${normalized}`}>{status || "-"}</span>;
}
