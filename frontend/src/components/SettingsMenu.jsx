import { defaultAutoTradeStrategies } from "../lib/settings";

export function SettingsMenu({
  accountId,
  autoTrade,
  disabled,
  onApplyRisk,
  onAutoTradeChange,
  onRiskChange,
  riskSettings,
}) {
  return (
    <div className="settings-menu-content">
      <div className="settings-menu-heading">
        <div>
          <h2>Settings</h2>
          <p className="muted">
            Alert rules reset · {autoTrade.enabled ? "Auto Long on" : "Auto Long off"}
          </p>
        </div>
      </div>
      <RiskSettingsPanel
        disabled={disabled}
        onApply={onApplyRisk}
        onChange={onRiskChange}
        riskSettings={riskSettings}
      />
      <AutoTradePanel
        accountId={accountId}
        autoTrade={autoTrade}
        disabled={disabled}
        onChange={onAutoTradeChange}
      />
    </div>
  );
}

function RiskSettingsPanel({ disabled, riskSettings, onApply, onChange }) {
  function update(key, value) {
    onChange({ ...riskSettings, [key]: value });
  }

  return (
    <section className="risk-settings-panel" aria-label="A++ risk settings">
      <div className="risk-field">
        <span>Max risk</span>
        <label>
          <b>$</b>
          <input
            type="number"
            min="1"
            max="10000"
            step="1"
            value={riskSettings.riskAmount}
            disabled={disabled}
            onChange={(event) => update("riskAmount", event.target.value)}
          />
        </label>
      </div>
      <div className="risk-field">
        <span>SL mode</span>
        <select
          value={riskSettings.stopMode}
          disabled={disabled}
          onChange={(event) => update("stopMode", event.target.value)}
        >
          <option value="auto">Auto range</option>
          <option value="fixed">Fixed $</option>
        </select>
      </div>
      {riskSettings.stopMode === "fixed" ? (
        <div className="risk-field">
          <span>Cloud buffer</span>
          <label>
            <b>$</b>
            <input
              type="number"
              min="0.05"
              max="25"
              step="0.05"
              value={riskSettings.fixedStopBuffer}
              disabled={disabled}
              onChange={(event) => update("fixedStopBuffer", event.target.value)}
            />
          </label>
        </div>
      ) : (
        <div className="risk-field auto-risk-note">
          <span>Range</span>
          <strong>Last 3D</strong>
        </div>
      )}
      <button type="button" className="risk-apply-button" disabled={disabled} onClick={onApply}>
        Apply
      </button>
    </section>
  );
}

function AutoTradePanel({ accountId, autoTrade, disabled, onChange }) {
  return (
    <section className={`auto-trade-panel ${autoTrade.enabled ? "enabled" : ""}`} aria-label="Auto long trading">
      <div className="auto-trade-topline">
        <label className="auto-trade-toggle">
          <input
            type="checkbox"
            checked={autoTrade.enabled}
            disabled={disabled || !accountId}
            onChange={(event) => onChange({ ...autoTrade, enabled: event.target.checked })}
          />
          <span>
            <strong>Auto Long</strong>
            <small>Paused until new alert rules are defined.</small>
          </span>
        </label>
        <em>{accountId ? "No rules" : "Select account"}</em>
      </div>
    </section>
  );
}

export function normalizeAutoTradeSettings(nextSettings, currentStrategies = {}) {
  return {
    enabled: Boolean(nextSettings.enabled),
    strategies: { ...defaultAutoTradeStrategies(), ...(nextSettings.strategies || currentStrategies || {}) },
  };
}
