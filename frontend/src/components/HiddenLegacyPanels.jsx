export function HiddenLegacyPanels() {
  return (
    <>
      <section className="strategy-panel hidden">
        <div className="section-heading">
          <div>
            <h2>Ready To Trade</h2>
            <p className="muted">10m EMA cloud scanner kept hidden for now.</p>
          </div>
          <button type="button">Scan Watchlist</button>
        </div>
      </section>

      <section className="tradingview-panel hidden">
        <div className="section-heading">
          <div>
            <h2>TradingView MCP</h2>
            <p className="muted">Read-only MCP panel kept hidden for now.</p>
          </div>
          <button type="button">Analyze</button>
        </div>
      </section>
    </>
  );
}
