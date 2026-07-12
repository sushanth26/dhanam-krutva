export const DAILY_SYMBOLS_KEY = "dhanam-daily-symbols";
export const WATCHLISTS_KEY = "dhanam-watchlists";
export const OG_WATCHLIST_ID = "og";
export const OG_SYMBOLS = [
  "BE", "CRDO", "AAOI", "SNDK", "MU", "GLW", "MRVL", "COHR", "RKLB",
  "ASTS", "AMD", "ARM", "AVGO", "DELL", "INTC", "APP", "LLY",
  "APLD", "CIFR", "CRWV", "HUT", "IREN", "NBIS", "WULF",
];

export function loadDailySymbols() {
  try {
    const value = JSON.parse(window.localStorage.getItem(DAILY_SYMBOLS_KEY) || "[]");
    return Array.isArray(value) ? normalizeSymbols(value) : [];
  } catch {
    return [];
  }
}

export function loadWatchlists() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(WATCHLISTS_KEY) || "[]");
    if (Array.isArray(saved) && saved.length) {
      return normalizeWatchlists(saved);
    }
  } catch {
    // Fall back to the seeded lists below.
  }
  const dailySymbols = loadDailySymbols();
  return normalizeWatchlists([
    { id: OG_WATCHLIST_ID, name: "OG list", symbols: OG_SYMBOLS, locked: true },
    ...(dailySymbols.length ? [{ id: "daily", name: "Daily list", symbols: dailySymbols }] : []),
  ]);
}

export function saveWatchlists(watchlists) {
  window.localStorage.setItem(WATCHLISTS_KEY, JSON.stringify(watchlists));
}

export function normalizeWatchlists(watchlists) {
  const normalized = [];
  const seenIds = new Set();
  for (const item of watchlists) {
    const name = String(item?.name || "").trim() || "Watchlist";
    const baseId = item?.id === OG_WATCHLIST_ID ? OG_WATCHLIST_ID : slugify(name);
    const id = uniqueId(baseId, seenIds);
    seenIds.add(id);
    normalized.push({
      id,
      name: id === OG_WATCHLIST_ID ? "OG list" : name,
      symbols: normalizeSymbols(item?.symbols || []).slice(0, 25),
      locked: id === OG_WATCHLIST_ID,
      autoTradeEnabled: item?.autoTradeEnabled !== false && item?.auto_trade_enabled !== false && item?.do_not_auto_trade !== true,
    });
  }
  if (!normalized.some((item) => item.id === OG_WATCHLIST_ID)) {
    normalized.unshift({ id: OG_WATCHLIST_ID, name: "OG list", symbols: OG_SYMBOLS, locked: true, autoTradeEnabled: true });
  }
  return normalized;
}

export function normalizeSymbols(value) {
  const seen = new Set();
  return value
    .flatMap((item) => String(item || "").split(/[,\s]+/))
    .map((symbol) => symbol.trim().toUpperCase())
    .filter((symbol) => {
      if (!symbol || seen.has(symbol)) return false;
      seen.add(symbol);
      return true;
    });
}

export function slugify(value) {
  return String(value || "watchlist").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "watchlist";
}

export function uniqueId(baseId, usedIds) {
  let id = baseId || "watchlist";
  let index = 2;
  while (usedIds.has(id)) {
    id = `${baseId}-${index}`;
    index += 1;
  }
  return id;
}

export function initialTabState(watchlists, value) {
  return watchlists.reduce((state, watchlist) => ({ ...state, [watchlist.id]: value }), {});
}

export function shouldPromoteLocalWatchlists(serverWatchlists, localWatchlists) {
  const serverOnlyDefaultOg = serverWatchlists.length === 1
    && serverWatchlists[0]?.id === OG_WATCHLIST_ID
    && serverWatchlists[0]?.symbols?.join(",") === OG_SYMBOLS.join(",");
  const localHasCustomState = localWatchlists.length > 1
    || localWatchlists[0]?.symbols?.join(",") !== OG_SYMBOLS.join(",");
  return serverOnlyDefaultOg && localHasCustomState;
}
