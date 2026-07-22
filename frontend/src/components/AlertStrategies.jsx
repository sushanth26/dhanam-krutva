export function AlertStrategies() {
  return (
    <section className="alert-strategies" aria-label="Alert strategies">
      <div className="alert-strategies-heading">
        <div>
          <h3>MTF Table Alerts</h3>
          <p className="muted">Only new rows on the MTF table notify.</p>
        </div>
      </div>
      <div className="mtf-alert-rule">
        <strong>Automatic</strong>
        <span>Any confirmed setup that newly appears in the MTF table sends a notification. Scanner, BOS, SPY, and manual strategy filters are off.</span>
      </div>
    </section>
  );
}
