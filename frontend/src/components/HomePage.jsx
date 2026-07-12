import { PriceBucket } from "./PriceTables";
import { WatchlistTabs } from "./WatchlistTabs";

export function HomePage({
  activeWatchlist,
  liveAlert,
  loading,
  onAddSymbols,
  onAddTab,
  onDeleteTab,
  onRefreshAll,
  onRefreshPrices,
  onRemoveSymbol,
  onSymbolInput,
  onSwitchTab,
  onToggleAutoTrade,
  symbolInput,
  trendBuckets,
  updatedText,
  watchlistTab,
  watchlists,
}) {
  return (
    <div className="homepage-market-grid">
      <section className="live-prices-panel">
        <WatchlistTabs
          activeTab={watchlistTab}
          onAddSymbols={onAddSymbols}
          onAddTab={onAddTab}
          onDeleteTab={onDeleteTab}
          onRefreshAll={onRefreshAll}
          loading={loading.watchlists || loading.prices}
          onSymbolInput={onSymbolInput}
          onSwitchTab={onSwitchTab}
          onToggleAutoTrade={onToggleAutoTrade}
          selectedWatchlist={activeWatchlist}
          symbolInput={symbolInput}
          watchlists={watchlists}
        />
        <div className="section-heading">
          <div>
            <h2>{activeWatchlist?.name || "Watchlist"}</h2>
            <p className="muted">Live Webull prices with clock-aligned EMA levels.</p>
          </div>
          <div className="live-price-actions">
            <button type="button" onClick={onRefreshPrices} disabled={loading.prices}>
              Refresh Prices
            </button>
          </div>
        </div>

        {liveAlert ? <div className="alert">{liveAlert}</div> : null}

        <div className="active-watchlist-tables">
          <div className="trend-price-grid">
            <PriceBucket title="Bullish" quotes={trendBuckets.bullish} kind="bullish" onRemoveSymbol={onRemoveSymbol} />
            <PriceBucket title="Bearish" quotes={trendBuckets.bearish} kind="bearish" onRemoveSymbol={onRemoveSymbol} />
            <PriceBucket title="Chop" quotes={trendBuckets.chop} kind="chop" onRemoveSymbol={onRemoveSymbol} />
          </div>
          <p className="muted">{updatedText}</p>
        </div>
      </section>
    </div>
  );
}
