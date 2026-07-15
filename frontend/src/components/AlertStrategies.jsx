import { ALERT_STRATEGIES } from "../lib/alertStrategies";

export function AlertStrategies({ strategyState, onToggleStrategy }) {
  const enabledCount = ALERT_STRATEGIES.filter((strategy) => strategyState[strategy.id] !== false).length;
  return (
    <section className="alert-strategies" aria-label="Alert strategies">
      <div className="alert-strategies-heading">
        <div>
          <h3>Alert Strategies</h3>
          <p className="muted">{enabledCount} active</p>
        </div>
      </div>
      <div className="strategy-list">
        {ALERT_STRATEGIES.map((strategy) => {
          const enabled = strategyState[strategy.id] !== false;
          return (
            <label key={strategy.id} className={`strategy-toggle ${enabled ? "enabled" : "disabled"}`}>
              <input
                checked={enabled}
                onChange={() => onToggleStrategy(strategy.id)}
                type="checkbox"
              />
              <span>
                <strong>{strategy.name}</strong>
                <small>{strategy.description}</small>
              </span>
            </label>
          );
        })}
      </div>
    </section>
  );
}
