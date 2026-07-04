const STORAGE_KEY = "dhanam-alert-strategies";

export const ALERT_STRATEGIES = [
  {
    id: "hourly-cloud",
    name: "Hourly 34/50",
    description: "Price is inside the hourly 34/50 EMA cloud.",
    match: (match) => String(match?.label || "").includes("Hourly 34/50"),
  },
  {
    id: "daily-fast-cloud",
    name: "Daily 20/21",
    description: "Price is inside the daily 20/21 EMA cloud.",
    match: (match) => String(match?.label || "").includes("Daily 20/21"),
  },
  {
    id: "daily-slow-cloud",
    name: "Daily 50/55",
    description: "Price is inside the daily 50/55 EMA cloud.",
    match: (match) => String(match?.label || "").includes("Daily 50/55"),
  },
  {
    id: "ten-minute-touch",
    name: "10m EMA reclaim",
    description: "10m candle touches or goes below an EMA, then closes above it.",
    match: (match) => match?.type === "10m_touch" || String(match?.label || "").includes("10m touch"),
  },
];

export function defaultStrategyState() {
  return Object.fromEntries(ALERT_STRATEGIES.map((strategy) => [strategy.id, true]));
}

export function loadStrategyState() {
  const defaults = defaultStrategyState();
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}");
    return { ...defaults, ...saved };
  } catch {
    return defaults;
  }
}

export function saveStrategyState(state) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function strategyIdForMatch(match) {
  return ALERT_STRATEGIES.find((strategy) => strategy.match(match))?.id || "unknown";
}

export function filterMatchesByStrategy(matches = [], strategyState = defaultStrategyState()) {
  return matches.filter((match) => strategyState[strategyIdForMatch(match)] !== false);
}

export function filterQuotesByStrategy(quotes = [], strategyState = defaultStrategyState()) {
  return quotes
    .map((quote) => ({ ...quote, mtf_matches: filterMatchesByStrategy(quote.mtf_matches, strategyState) }))
    .filter((quote) => quote.mtf_matches.length);
}
