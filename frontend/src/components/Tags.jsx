import { mtfTagClass } from "../lib/market";

export function CloudTag({ status }) {
  const normalized = ["Bullish", "Bearish", "Chop"].includes(status) ? String(status).toLowerCase() : "unknown";
  return <span className={`cloud-tag ${normalized}`}>{status || "-"}</span>;
}

export function MtfTag({ label }) {
  return <span className={`mtf-tag ${mtfTagClass(label)}`}>{label}</span>;
}
