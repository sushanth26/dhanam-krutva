const STORAGE_KEY = "dhanam-alert-strategies";

export const ALERT_STRATEGIES = [
  {
    id: "pre-market-scanner",
    name: "Pre Market Scanner",
    description: "Stock enters or leaves the YH/YL premarket scanner.",
    scannerOnly: true,
    match: () => false,
  },
  {
    id: "hourly-cloud",
    name: "Hourly 5/12",
    description: "Price breaks through or touches the hourly 5/12 EMA cloud.",
    match: (match) => String(match?.label || "") === "Hourly 5/12",
  },
  {
    id: "daily-fast-cloud",
    name: "Daily 20/21",
    description: "Price breaks through or touches the daily 20/21 EMA cloud.",
    match: (match) => String(match?.label || "") === "Daily 20/21",
  },
  {
    id: "daily-slow-cloud",
    name: "Daily 50/55",
    description: "Price breaks through or touches the daily 50/55 EMA cloud.",
    match: (match) => String(match?.label || "") === "Daily 50/55",
  },
  {
    id: "ten-minute-bounce-10m",
    name: "10m bounce/rejection 34/50",
    description: "10m candle touches the 10m 34/50 EMA cloud with trend direction.",
    match: (match) => ["10m bounce 34/50", "10m 34/50 touch"].includes(String(match?.label || "")),
  },
  {
    id: "ten-minute-9ema-touch",
    name: "10m 9 EMA touch",
    description: "Bullish 10m stock touches the 9 EMA with SL at the 10m 34/50 cloud low.",
    match: (match) => String(match?.label || "") === "10m 9 EMA touch",
  },
  {
    id: "ten-minute-40ema-touch",
    name: "10m 40 EMA touch",
    description: "Bullish 10m stock touches the 40 EMA with SL at the 10m 34/50 cloud low.",
    match: (match) => String(match?.label || "") === "10m 40 EMA touch",
  },
  {
    id: "ten-minute-bounce-hourly",
    name: "10m bounce/rejection 1hr 5/12",
    description: "10m candle rejects or bounces through the hourly 5/12 EMA cloud with trend direction.",
    match: (match) => String(match?.label || "") === "10m bounce Hourly 5/12",
  },
  {
    id: "ten-minute-bounce-daily-fast",
    name: "10m bounce/rejection Daily 20/21",
    description: "10m candle rejects or bounces through the daily 20/21 EMA cloud with trend direction.",
    match: (match) => String(match?.label || "") === "10m bounce Daily 20/21",
  },
  {
    id: "ten-minute-bounce-daily-slow",
    name: "10m bounce/rejection Daily 50/55",
    description: "10m candle rejects or bounces through the daily 50/55 EMA cloud with trend direction.",
    match: (match) => String(match?.label || "") === "10m bounce Daily 50/55",
  },
];

const MTF_TABLE_ALERT_LABELS = new Set(["Hourly 5/12", "Daily 20/21", "Daily 50/55"]);

export const MTF_ALERT_STRATEGIES = ALERT_STRATEGIES.filter((strategy) => (
  !strategy.scannerOnly && MTF_TABLE_ALERT_LABELS.has(strategy.name)
));

export function defaultStrategyState() {
  return Object.fromEntries(ALERT_STRATEGIES.map((strategy) => [strategy.id, !strategy.scannerOnly]));
}

function automaticMtfStrategyState() {
  return { ...defaultStrategyState(), ...Object.fromEntries(MTF_ALERT_STRATEGIES.map((strategy) => [strategy.id, true])) };
}

export function loadStrategyState() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}");
    const legacyBounce = saved["ten-minute-bounce"] ?? saved["ten-minute-touch"];
    if (legacyBounce !== undefined) {
      delete saved["ten-minute-bounce"];
      delete saved["ten-minute-touch"];
    }
    const next = { ...saved, ...automaticMtfStrategyState(), "pre-market-scanner": false };
    saveStrategyState(next);
    return next;
  } catch {
    return automaticMtfStrategyState();
  }
}

export function saveStrategyState(state) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, ...automaticMtfStrategyState(), "pre-market-scanner": false }));
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

export function filterMtfTableQuotes(quotes = []) {
  return quotes
    .map((quote) => ({
      ...quote,
      mtf_matches: (quote.mtf_matches || []).filter((match) => MTF_TABLE_ALERT_LABELS.has(String(match?.label || ""))),
    }))
    .filter((quote) => quote.mtf_matches.length);
}
