export function WatchlistTabs({
  activeTab,
  onAddSymbols,
  onAddTab,
  onDeleteTab,
  onRefreshAll,
  loading,
  onSwitchTab,
  onSymbolInput,
  onToggleAutoTrade,
  selectedWatchlist,
  symbolInput,
  watchlists,
}) {
  return (
    <section className="watchlist-panel" aria-label="Watchlists">
      <div className="watchlist-tabs" role="tablist" aria-label="Watchlist tabs">
        {watchlists.map((watchlist) => (
          <span key={watchlist.id} className={`watchlist-tab ${activeTab === watchlist.id ? "active" : ""}`}>
            <button
              type="button"
              onClick={() => onSwitchTab(watchlist.id)}
              role="tab"
              aria-selected={activeTab === watchlist.id}
            >
              {watchlist.name}
              <b>{watchlist.symbols.length}</b>
            </button>
            {!watchlist.locked ? (
              <button
                type="button"
                className="watchlist-delete"
                onClick={() => onDeleteTab(watchlist.id)}
                aria-label={`Delete ${watchlist.name}`}
              >
                x
              </button>
            ) : null}
          </span>
        ))}
        <button
          type="button"
          className="watchlist-add-tab"
          onClick={onAddTab}
          aria-label="Add watchlist tab"
          title="Add watchlist tab"
        >
          +
        </button>
        <button
          type="button"
          className="watchlist-refresh-all"
          onClick={onRefreshAll}
          disabled={loading}
        >
          Refresh All
        </button>
      </div>
      <div className="daily-list-editor">
        <label className="watchlist-auto-trade-toggle">
          <input
            type="checkbox"
            checked={selectedWatchlist?.autoTradeEnabled === false}
            disabled={!selectedWatchlist || loading}
            onChange={(event) => onToggleAutoTrade(selectedWatchlist.id, !event.target.checked)}
          />
          <span>Do not auto trade this watchlist</span>
        </label>
        <form onSubmit={onAddSymbols}>
          <input
            aria-label={`Add symbols to ${selectedWatchlist?.name || "watchlist"}`}
            placeholder="Add ticker"
            value={symbolInput}
            onChange={(event) => onSymbolInput(event.target.value)}
          />
          <button type="submit" disabled={loading}>Add</button>
        </form>
      </div>
    </section>
  );
}
