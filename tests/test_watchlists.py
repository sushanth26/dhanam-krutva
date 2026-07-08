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

    assert saved[0] == {
        "id": "og",
        "name": "OG list",
        "symbols": ["BE", "PLTR"],
        "locked": True,
        "auto_trade_enabled": True,
    }
    assert saved[1]["id"] == "ai-names"
    assert saved[1]["symbols"] == ["NVDA", "PLTR"]
    assert saved[1]["auto_trade_enabled"] is True
    assert store.all() == saved


def test_normalize_watchlists_preserves_auto_trade_disabled():
    watchlists = normalize_watchlists(
        [
            {"id": "og", "symbols": ["BE"]},
            {"name": "Daily", "symbols": ["HUT"], "auto_trade_enabled": False},
            {"name": "Swing", "symbols": ["PLTR"], "do_not_auto_trade": True},
        ]
    )

    assert watchlists[1]["auto_trade_enabled"] is False
    assert watchlists[2]["auto_trade_enabled"] is False


def test_normalize_watchlists_restores_missing_og():
    watchlists = normalize_watchlists([{"name": "Daily", "symbols": ["HUT"]}])

    assert watchlists[0]["id"] == OG_WATCHLIST_ID
    assert watchlists[1]["id"] == "daily"
