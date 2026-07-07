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


def test_auto_long_uses_saved_watchlist_and_places_full_size_bracket_payload(tmp_path, monkeypatch):
    watchlist_file = tmp_path / "watchlists.json"
    WatchlistStore(watchlist_file).replace([{"id": "og", "symbols": ["AAOI"]}])
    monkeypatch.setattr(trade, "get_settings", lambda: SimpleNamespace(watchlist_file=watchlist_file))

    class FakeService:
        def account_list(self):
            return {"data": [{"accountId": "acct-1", "accountType": "MARGIN"}]}

        def buy_with_bracket(self, **kwargs):
            return {"ok": True, **kwargs}

    monkeypatch.setattr(trade, "service", lambda: FakeService())

    response = trade.auto_buy_with_bracket(
        trade.AutoLongRequest(
            account_id="acct-1",
            symbol="aaoi",
            quantity=7,
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
    assert response["quantity"] == 7
    assert response["entry_price"] == 100
    assert response["stop_price"] == 95
    assert response["target_price"] == 105


def test_auto_long_rejects_cash_account(tmp_path, monkeypatch):
    watchlist_file = tmp_path / "watchlists.json"
    WatchlistStore(watchlist_file).replace([{"id": "og", "symbols": ["AAOI"]}])
    monkeypatch.setattr(trade, "get_settings", lambda: SimpleNamespace(watchlist_file=watchlist_file))

    class FakeService:
        def account_list(self):
            return {"data": [{"accountId": "cash-1", "accountType": "CASH"}]}

        def buy_with_bracket(self, **kwargs):
            raise AssertionError("cash accounts must not place orders")

    monkeypatch.setattr(trade, "service", lambda: FakeService())

    try:
        trade.auto_buy_with_bracket(
            trade.AutoLongRequest(
                account_id="cash-1",
                symbol="AAOI",
                quantity=7,
                entry_price=100,
                stop_price=95,
                target_price=105,
            )
        )
    except HTTPException as exc:
        assert exc.status_code == 400
        assert exc.detail == "Trading requires a margin account."
    else:
        raise AssertionError("auto long should reject cash accounts")


def test_auto_long_rejects_symbols_outside_saved_watchlists(tmp_path, monkeypatch):
    watchlist_file = tmp_path / "watchlists.json"
    WatchlistStore(watchlist_file).replace([{"id": "og", "symbols": ["BE"]}])
    monkeypatch.setattr(trade, "get_settings", lambda: SimpleNamespace(watchlist_file=watchlist_file))

    try:
        trade.auto_buy_with_bracket(
            trade.AutoLongRequest(account_id="acct-1", symbol="AAOI", quantity=7, entry_price=100, stop_price=95, target_price=105)
        )
    except HTTPException as exc:
        assert exc.status_code == 400
        assert exc.detail == "Symbol is not in the approved strategy watchlist."
    else:
        raise AssertionError("auto long should reject symbols outside saved watchlists")


def test_sell_limit_payload_uses_target_price():
    payload = WebullService._stock_order_payload(
        symbol="AAOI",
        quantity="7",
        client_order_id="client-1",
        side="SELL",
        order_type="LIMIT",
        combo_type="STOP_PROFIT",
        limit_price=105,
    )

    assert payload["combo_type"] == "STOP_PROFIT"
    assert payload["side"] == "SELL"
    assert payload["order_type"] == "LIMIT"
    assert payload["quantity"] == "7"
    assert payload["limit_price"] == "105.00"


def test_sell_stop_payload_uses_stop_price_for_full_size():
    payload = WebullService._stock_order_payload(
        symbol="AAOI",
        quantity="7",
        client_order_id="client-1",
        side="SELL",
        order_type="STOP_LOSS",
        combo_type="STOP_LOSS",
        stop_price=95,
    )

    assert payload["combo_type"] == "STOP_LOSS"
    assert payload["side"] == "SELL"
    assert payload["order_type"] == "STOP_LOSS"
    assert payload["quantity"] == "7"
    assert payload["stop_price"] == "95.00"
