from types import SimpleNamespace

from app.routers import trade
from app.watchlists import WatchlistStore


def test_approved_trade_symbols_use_saved_watchlists(tmp_path, monkeypatch):
    watchlist_file = tmp_path / "watchlists.json"
    WatchlistStore(watchlist_file).replace(
        [
            {"id": "og", "symbols": ["BE"]},
            {"name": "Daily", "symbols": ["PLTR", "AAOI"]},
        ]
    )
    monkeypatch.setattr(trade, "get_settings", lambda: SimpleNamespace(watchlist_file=watchlist_file))

    assert {"BE", "PLTR", "AAOI"}.issubset(trade.approved_trade_symbols())
