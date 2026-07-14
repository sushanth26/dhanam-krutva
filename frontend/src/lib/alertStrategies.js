import { getJson, postJson } from "./api";

export const ALERT_STRATEGIES = [
  {
    key: "playableTrades",
    name: "Playable Trades",
    matchTypes: ["playable_trade"],
    description: "Trade thesis is Playable with confirmation and acceptable R:R.",
  },
  {
    key: "scannerEntry",
    name: "Entry Alerts",
    matchTypes: ["scanner_entry"],
    description: "Scanner says Entry after the setup clears its read filters.",
  },
  {
    key: "curls",
    name: "Curls",
    matchTypes: ["long_mtf_5_12_touch"],
    description: "MTF touch first, then price moves back above 10m 5/12.",
  },
  {
    key: "tenMinute3450Bounce",
    name: "10m 34/50 Bounce/Rejection",
    matchTypes: ["10m_34_50_bounce"],
    description: "Confirmed 10m close back above or below the 34/50 cloud after touching it.",
  },
  {
    key: "mtfCloudTouch",
    name: "MTF Cloud Touch",
    matchTypes: ["mtf_cloud_price_touch"],
    description: "Live price sits inside the Hourly 34/50, Daily 20/21, or Daily 50/55 cloud. Fires once per 10m candle.",
  },
];

const MATCH_TYPE_TO_STRATEGY_KEY = ALERT_STRATEGIES.reduce((lookup, strategy) => {
  for (const type of strategy.matchTypes) lookup[type] = strategy.key;
  return lookup;
}, {});

export function defaultAlertStrategies() {
  return Object.fromEntries(ALERT_STRATEGIES.map((strategy) => [strategy.key, true]));
}

export function strategyKeyForMatch(match) {
  return MATCH_TYPE_TO_STRATEGY_KEY[match?.type] || null;
}

export function alertStrategyEnabled(match, strategies = defaultAlertStrategies()) {
  const key = strategyKeyForMatch(match);
  return Boolean(key && strategies[key] !== false);
}

export async function fetchAlertStrategies() {
  const body = await getJson("/api/notifications/strategies");
  return { ...defaultAlertStrategies(), ...(body.strategies || {}) };
}

export async function saveAlertStrategiesRemote(strategies) {
  const body = await postJson("/api/notifications/strategies", { strategies });
  return { ...defaultAlertStrategies(), ...(body.strategies || {}) };
}
