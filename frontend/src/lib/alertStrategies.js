export const ALERT_STRATEGIES = [
  {
    key: "curls",
    name: "Curls",
    matchTypes: ["long_mtf_5_12_touch"],
    description: "MTF touch first, then price moves back above 10m 5/12.",
  },
  {
    key: "tenMinute3450Bounce",
    name: "10m 34/50 Bounce",
    matchTypes: ["10m_34_50_bounce"],
    description: "Confirmed 10m close back above the 34/50 cloud after touching it.",
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
