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

  if (fastBottom > slowTop) return "Bullish";
  if (fastTop < slowBottom) return "Bearish";
  return "Chop";
}

const EASTERN_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const WEEKDAY_INDEX = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function easternMarketTime(date = new Date()) {
  const parts = Object.fromEntries(EASTERN_TIME_FORMATTER.formatToParts(date).map((part) => [part.type, part.value]));
  const weekday = WEEKDAY_INDEX[parts.weekday];
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return {
    day: parts.day,
    minutes,
    month: parts.month,
    weekday,
    year: parts.year,
  };
}

function isEasternWeekday(parts) {
  return parts.weekday > 0 && parts.weekday < 6;
}

export function isMarketRefreshWindow(date = new Date()) {
  const parts = easternMarketTime(date);
  if (!isEasternWeekday(parts)) return false;
  return parts.minutes >= 3 * 60 && parts.minutes < 19 * 60;
}

export function shouldUseManualRefresh(date = new Date()) {
  const parts = easternMarketTime(date);
  if (!isEasternWeekday(parts)) return true;
  return parts.minutes < 9 * 60 || parts.minutes >= 16 * 60;
}

export function marketDateKey(date = new Date()) {
  const parts = easternMarketTime(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}
