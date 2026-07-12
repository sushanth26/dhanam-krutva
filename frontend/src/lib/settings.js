import { defaultAlertStrategies } from "./alertStrategies";

export const RISK_SETTINGS_KEY = "dhanam-risk-settings";
export const AUTO_TRADE_KEY = "dhanam-auto-trade";

export function loadRiskSettings() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(RISK_SETTINGS_KEY) || "{}");
    return normalizeRiskSettings(saved);
  } catch {
    return normalizeRiskSettings({});
  }
}

export function normalizeRiskSettings(settings) {
  const riskAmount = Number(settings?.riskAmount);
  const fixedStopBuffer = Number(settings?.fixedStopBuffer);
  const stopMode = settings?.stopMode === "auto" ? "auto" : "fixed";
  return {
    riskAmount: Number.isFinite(riskAmount) ? clamp(riskAmount, 1, 10000) : 100,
    stopMode,
    fixedStopBuffer: Number.isFinite(fixedStopBuffer) ? clamp(fixedStopBuffer, 0.05, 25) : 1,
  };
}

export function saveRiskSettings(settings) {
  window.localStorage.setItem(RISK_SETTINGS_KEY, JSON.stringify(settings));
}

export function loadAutoTradeSettings() {
  const defaults = defaultAutoTradeStrategies();
  try {
    const saved = JSON.parse(window.localStorage.getItem(AUTO_TRADE_KEY) || "{}");
    return {
      enabled: Boolean(saved?.enabled),
      strategies: { ...defaults, ...(saved?.strategies || {}) },
    };
  } catch {
    return { enabled: false, strategies: defaults };
  }
}

export function saveAutoTradeSettings(settings) {
  window.localStorage.setItem(AUTO_TRADE_KEY, JSON.stringify({
    enabled: Boolean(settings.enabled),
    strategies: { ...defaultAutoTradeStrategies(), ...(settings.strategies || {}) },
  }));
}

export function defaultAutoTradeStrategies() {
  return defaultAlertStrategies();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
