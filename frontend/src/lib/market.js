export function formatPrice(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "-";
  return parsed.toFixed(2);
}

export function findAccountId(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAccountId(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const key of ["account_id", "accountId", "id"]) {
      if (value[key]) return String(value[key]);
    }
    for (const item of Object.values(value)) {
      const found = findAccountId(item);
      if (found) return found;
    }
  }
  return null;
}

export function flattenAccounts(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.accounts)) return data.accounts;
  if (Array.isArray(data.account_list)) return data.account_list;
  if (Array.isArray(data.data)) return data.data;
  return [data];
}

export function cloudStatus(emaSet, fastKeys, slowKeys) {
  const fastValues = fastKeys.map((key) => Number(emaSet?.[key]));
  const slowValues = slowKeys.map((key) => Number(emaSet?.[key]));
  if ([...fastValues, ...slowValues].some((value) => !Number.isFinite(value))) return "-";

  const fastBottom = Math.min(...fastValues);
  const fastTop = Math.max(...fastValues);
  const slowBottom = Math.min(...slowValues);
  const slowTop = Math.max(...slowValues);

  if (fastBottom > slowTop) return "Bullish";
  if (fastTop < slowBottom) return "Bearish";
  return "Chop";
}

export function emaTooltip(quote) {
  const e10 = quote.ema_10m || {};
  const e1h = quote.ema_1h || {};
  const daily = quote.ema_daily || {};
  return [
    `10m EMA 5: ${formatPrice(e10["5"])}`,
    `10m EMA 12: ${formatPrice(e10["12"])}`,
    `10m EMA 34: ${formatPrice(e10["34"])}`,
    `10m EMA 50: ${formatPrice(e10["50"])}`,
    `1h EMA 20: ${formatPrice(e1h["20"])}`,
    `1h EMA 21: ${formatPrice(e1h["21"])}`,
    `1h EMA 34: ${formatPrice(e1h["34"])}`,
    `1h EMA 50: ${formatPrice(e1h["50"])}`,
    `1h EMA 55: ${formatPrice(e1h["55"])}`,
    `Daily EMA 20: ${formatPrice(daily["20"])}`,
    `Daily EMA 21: ${formatPrice(daily["21"])}`,
    `Daily EMA 50: ${formatPrice(daily["50"])}`,
    `Daily EMA 55: ${formatPrice(daily["55"])}`,
  ].join("\n");
}

export function mtfTagClass(label) {
  const normalized = String(label || "").toLowerCase();
  if (normalized.includes("hourly")) return "hourly";
  if (normalized.includes("daily 20/21")) return "daily-fast";
  if (normalized.includes("daily 50/55")) return "daily-slow";
  return "default";
}

export function describeMtfMatches(quotes) {
  return quotes
    .map((quote) => {
      const labels = (quote.mtf_matches || []).map((match) => match.label).join(" + ");
      return labels ? `${quote.symbol} ${labels}` : quote.symbol;
    })
    .join(" • ");
}

export function mtfSignature(quotes) {
  return quotes
    .map((quote) => `${quote.symbol}:${(quote.mtf_matches || []).map((match) => match.label).join("|")}`)
    .sort()
    .join(",");
}

export function groupBySector(quotes) {
  return quotes.reduce((groups, quote) => {
    const sector = quote.sector || "Other";
    groups[sector] = groups[sector] || [];
    groups[sector].push(quote);
    return groups;
  }, {});
}

export function sectorSlug(sector) {
  return String(sector || "Other").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function isMarketRefreshWindow(date = new Date()) {
  const day = date.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = date.getHours() * 60 + date.getMinutes();
  return minutes >= 3 * 60 && minutes < 15 * 60;
}
