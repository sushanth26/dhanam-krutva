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
    name: "Hourly 34/50",
    description: "Price breaks through or touches the hourly 34/50 EMA cloud.",
    match: (match) => String(match?.label || "") === "Hourly 34/50",
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
    match: (match) => String(match?.label || "") === "10m bounce 34/50",
  },
  {
    id: "ten-minute-9ema-touch",
    name: "10m 9 EMA touch",
    description: "Bullish 10m stock touches the 9 EMA with SL at the 10m 34/50 cloud low.",
    match: (match) => String(match?.label || "") === "10m 9 EMA touch",
  },
  {
    id: "ten-minute-bounce-hourly",
    name: "10m bounce/rejection 1hr 34/50",
    description: "10m candle rejects or bounces through the hourly 34/50 EMA cloud with trend direction.",
    match: (match) => String(match?.label || "") === "10m bounce Hourly 34/50",
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

export function defaultStrategyState() {
  return Object.fromEntries(ALERT_STRATEGIES.map((strategy) => [strategy.id, true]));
}

export function loadStrategyState() {
  const defaults = defaultStrategyState();
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}");
    const legacyBounce = saved["ten-minute-bounce"] ?? saved["ten-minute-touch"];
    if (legacyBounce !== undefined) {
      for (const key of [
        "ten-minute-bounce-10m",
        "ten-minute-bounce-hourly",
        "ten-minute-bounce-daily-fast",
        "ten-minute-bounce-daily-slow",
      ]) {
        if (saved[key] === undefined) saved[key] = legacyBounce;
      }
      delete saved["ten-minute-bounce"];
      delete saved["ten-minute-touch"];
      saveStrategyState({ ...defaults, ...saved });
    }
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
