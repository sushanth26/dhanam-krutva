const TEN_MINUTE_MIN_CLOUD_THICKNESS = 0.50;

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

export function accountTypeText(value) {
  if (!value) return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = accountTypeText(item);
      if (found) return found;
    }
    return "";
  }
  if (typeof value === "object") {
    for (const key of ["account_type", "accountType", "accountTypeName", "type", "broker"]) {
      if (value[key]) return String(value[key]).toUpperCase();
    }
    for (const item of Object.values(value)) {
      const found = accountTypeText(item);
      if (found) return found;
    }
  }
  return "";
}

export function isMarginAccount(account) {
  return accountTypeText(account).includes("MARGIN");
}

export function findAccountById(accounts, accountId) {
  if (!accountId) return null;
  return flattenAccounts(accounts).find((account) => findAccountId(account) === accountId) || null;
}

export function findMarginAccountId(accounts) {
  const marginAccount = flattenAccounts(accounts).find((account) => isMarginAccount(account));
  return findAccountId(marginAccount);
}

export function preferredAccountId(accounts, selectedAccountId = null) {
  const selectedAccount = findAccountById(accounts, selectedAccountId);
  if (isMarginAccount(selectedAccount)) return selectedAccountId;
  return findMarginAccountId(accounts) || selectedAccountId || findAccountId(accounts);
}

export function marginTradingAccountId(accounts, selectedAccountId = null) {
  const selectedAccount = findAccountById(accounts, selectedAccountId);
  if (isMarginAccount(selectedAccount)) return selectedAccountId;
  return findMarginAccountId(accounts);
}

export function cloudStatus(emaSet, fastKeys, slowKeys) {
  const fastValues = fastKeys.map((key) => Number(emaSet?.[key]));
  const slowValues = slowKeys.map((key) => Number(emaSet?.[key]));
  if ([...fastValues, ...slowValues].some((value) => !Number.isFinite(value))) return "-";

  const fastBottom = Math.min(...fastValues);
  const fastTop = Math.max(...fastValues);
  const slowBottom = Math.min(...slowValues);
  const slowTop = Math.max(...slowValues);

  if ((fastTop - fastBottom) < TEN_MINUTE_MIN_CLOUD_THICKNESS) return "Chop";
  if ((slowTop - slowBottom) < TEN_MINUTE_MIN_CLOUD_THICKNESS) return "Chop";

  if (fastBottom > slowTop) return "Bullish";
  if (fastTop < slowBottom) return "Bearish";
  return "Chop";
}

export function mtfTagClass(label) {
  const normalized = String(label || "").toLowerCase();
  if (normalized.includes("10m bounce") || normalized.includes("10m rejection")) return "touch";
  if (normalized.includes("hourly")) return "hourly";
  if (normalized.includes("daily 20/21")) return "daily-fast";
  if (normalized.includes("daily 50/55")) return "daily-slow";
  return "default";
}

export function displayMtfLabel(match) {
  const label = String(match?.display_label || match?.label || "");
  if (match?.trade_action === "Short" && label.includes("bounce")) {
    return label.replace("bounce", "rejection");
  }
  return label;
}

export function matchEntryPrice(match) {
  return match?.entry_price ?? match?.risk_plan?.entry ?? null;
}

export function notificationMatchText(match) {
  const label = displayMtfLabel(match);
  const entry = matchEntryPrice(match);
  return entry == null ? label : `${label} @ ${formatPrice(entry)}`;
}

export function confirmedMtfQuotes(quotes) {
  return quotes
    .map((quote) => ({
      ...quote,
      mtf_matches: (quote.mtf_matches || []).filter((match) => (match.status || "confirmed") === "confirmed"),
    }))
    .filter((quote) => quote.mtf_matches.length);
}

export function describeMtfMatches(quotes) {
  return quotes
    .map((quote) => {
      const labels = (quote.mtf_matches || []).map((match) => notificationMatchText(match)).join(" + ");
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

export function isMarketRefreshWindow(date = new Date()) {
  const day = date.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = date.getHours() * 60 + date.getMinutes();
  return minutes >= 3 * 60 && minutes < 15 * 60;
}
