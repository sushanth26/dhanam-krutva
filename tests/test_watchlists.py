from app.watchlists import OG_WATCHLIST_ID, WatchlistStore, normalize_watchlists


def test_watchlist_store_defaults_to_og_list(tmp_path):
    watchlists = WatchlistStore(tmp_path / "watchlists.json").all()

    assert watchlists[0]["id"] == OG_WATCHLIST_ID
    assert watchlists[0]["locked"] is True
    assert "BE" in watchlists[0]["symbols"]


def test_watchlist_store_saves_normalized_lists(tmp_path):
    store = WatchlistStore(tmp_path / "watchlists.json")

    saved = store.replace(
        [
            {"id": "og", "name": "Changed", "symbols": ["be", "BE", "pltr"]},
            {"name": "AI Names", "symbols": [" nvda, pltr  "]},
        ]
    )

    assert saved[0] == {"id": "og", "name": "OG list", "symbols": ["BE", "PLTR"], "locked": True}
    assert saved[1]["id"] == "ai-names"
    assert saved[1]["symbols"] == ["NVDA", "PLTR"]
    assert store.all() == saved


def test_normalize_watchlists_restores_missing_og():
    watchlists = normalize_watchlists([{"name": "Daily", "symbols": ["HUT"]}])

    assert watchlists[0]["id"] == OG_WATCHLIST_ID
    assert watchlists[1]["id"] == "daily"
