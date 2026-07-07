from types import SimpleNamespace

from fastapi import HTTPException

from app.routers import trade
from app.webull_service import WebullService
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


def test_auto_long_uses_saved_watchlist_and_places_bracket_payload(tmp_path, monkeypatch):
    watchlist_file = tmp_path / "watchlists.json"
    WatchlistStore(watchlist_file).replace([{"id": "og", "symbols": ["AAOI"]}])
    monkeypatch.setattr(trade, "get_settings", lambda: SimpleNamespace(watchlist_file=watchlist_file))

    class FakeService:
        def buy_one_with_take_profit(self, **kwargs):
            return {"ok": True, **kwargs}

    monkeypatch.setattr(trade, "service", lambda: FakeService())

    response = trade.auto_buy_one_share_with_take_profit(
        trade.AutoLongRequest(
            account_id="acct-1",
            symbol="aaoi",
            entry_price=100,
            stop_price=95,
            target_price=105,
            setup="10m bounce 34/50",
            candle_time="2026-07-07T09:30:00",
        )
    )

    assert response["ok"] is True
    assert response["account_id"] == "acct-1"
    assert response["symbol"] == "AAOI"
    assert response["entry_price"] == 100
    assert response["stop_price"] == 95
    assert response["target_price"] == 105


def test_auto_long_rejects_symbols_outside_saved_watchlists(tmp_path, monkeypatch):
    watchlist_file = tmp_path / "watchlists.json"
    WatchlistStore(watchlist_file).replace([{"id": "og", "symbols": ["BE"]}])
    monkeypatch.setattr(trade, "get_settings", lambda: SimpleNamespace(watchlist_file=watchlist_file))

    try:
        trade.auto_buy_one_share_with_take_profit(
            trade.AutoLongRequest(account_id="acct-1", symbol="AAOI", entry_price=100, stop_price=95, target_price=105)
        )
    except HTTPException as exc:
        assert exc.status_code == 400
        assert exc.detail == "Symbol is not in the approved strategy watchlist."
    else:
        raise AssertionError("auto long should reject symbols outside saved watchlists")


def test_sell_limit_payload_uses_target_price():
    payload = WebullService._stock_order_payload(
        symbol="AAOI",
        quantity="1",
        client_order_id="client-1",
        side="SELL",
        order_type="LIMIT",
        price=105,
    )

    assert payload["side"] == "SELL"
    assert payload["order_type"] == "LIMIT"
    assert payload["price"] == "105.00"
