from datetime import date, datetime, timedelta
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


def test_auto_long_uses_saved_watchlist_and_places_full_size_exit_payload(tmp_path, monkeypatch):
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


def test_manual_buy_requires_limit_price(tmp_path, monkeypatch):
    watchlist_file = tmp_path / "watchlists.json"
    WatchlistStore(watchlist_file).replace([{"id": "og", "symbols": ["AAOI"]}])
    monkeypatch.setattr(trade, "get_settings", lambda: SimpleNamespace(watchlist_file=watchlist_file))

    try:
        trade.buy_one_share(trade.BuyRequest(account_id="acct-1", symbol="AAOI"))
    except HTTPException as exc:
        assert exc.status_code == 400
        assert exc.detail == "Limit price is required for buy orders."
    else:
        raise AssertionError("manual buy should require a limit price")


def test_manual_buy_uses_limit_price(tmp_path, monkeypatch):
    watchlist_file = tmp_path / "watchlists.json"
    WatchlistStore(watchlist_file).replace([{"id": "og", "symbols": ["AAOI"]}])
    monkeypatch.setattr(trade, "get_settings", lambda: SimpleNamespace(watchlist_file=watchlist_file))

    class FakeService:
        def account_list(self):
            return {"data": [{"accountId": "acct-1", "accountType": "MARGIN"}]}

        def buy_one_order(self, **kwargs):
            return {"ok": True, **kwargs}

    monkeypatch.setattr(trade, "service", lambda: FakeService())

    response = trade.buy_one_share(trade.BuyRequest(account_id="acct-1", symbol="aaoi", limit_price=12.3456))

    assert response["ok"] is True
    assert response["account_id"] == "acct-1"
    assert response["symbol"] == "AAOI"
    assert response["limit_price"] == 12.3456


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


def test_auto_long_buys_first_then_places_linked_target_and_stop_for_full_size(monkeypatch):
    captured = {}
    calls = []

    class FakeResponse:
        status_code = 200
        headers = {}

        def __init__(self, body=None):
            self.body = body or {"ok": True}

        def json(self):
            return self.body

    class FakeOrderV3:
        def preview_order(self, account_id, new_orders, client_combo_order_id=None):
            calls.append(("preview", len(new_orders), client_combo_order_id))
            key = "exit_preview" if client_combo_order_id else "buy_preview"
            captured[key] = {
                "account_id": account_id,
                "new_orders": new_orders,
                "client_combo_order_id": client_combo_order_id,
            }
            return FakeResponse()

        def place_order(self, account_id, new_orders, client_combo_order_id=None):
            calls.append(("place", len(new_orders), client_combo_order_id))
            key = "exit_place" if client_combo_order_id else "buy_place"
            captured[key] = {
                "account_id": account_id,
                "new_orders": new_orders,
                "client_combo_order_id": client_combo_order_id,
            }
            return FakeResponse()

        def get_order_detail(self, account_id, client_order_id):
            calls.append(("detail", client_order_id, None))
            captured["buy_detail"] = {"account_id": account_id, "client_order_id": client_order_id}
            return FakeResponse({"order_status": "FILLED", "symbol": "AAOI", "filledQuantity": 7})

    service = WebullService.__new__(WebullService)
    service._trade_client = lambda: SimpleNamespace(order_v3=FakeOrderV3())
    monkeypatch.setattr("app.webull_service.time.sleep", lambda _seconds: None)
    monkeypatch.setattr(WebullService, "_is_regular_market_open", classmethod(lambda cls: False))

    response = service.buy_with_bracket(
        account_id="acct-1",
        symbol="AAOI",
        quantity=7,
        entry_price=100,
        stop_price=95,
        target_price=105,
    )

    buy_place = captured["buy_place"]
    exit_preview = captured["exit_preview"]
    exit_place = captured["exit_place"]
    buy = buy_place["new_orders"][0]
    assert response["ok"] is True
    assert response["stage"] == "complete"
    assert response["quantity"] == 7
    assert response["buy_fill"]["symbol"] == "AAOI"
    assert response["buy_fill"]["filled_quantity"] == 7
    assert calls == [
        ("preview", 1, None),
        ("place", 1, None),
        ("detail", response["orders"]["buy"]["client_order_id"], None),
        ("preview", 2, exit_preview["client_combo_order_id"]),
        ("place", 2, exit_place["client_combo_order_id"]),
    ]
    assert exit_preview["client_combo_order_id"] == exit_place["client_combo_order_id"]
    assert response["exit_combo_order_id"] == exit_place["client_combo_order_id"]
    assert response["orders"]["buy"]["client_order_id"].startswith("DKAT")
    assert response["orders"]["target"]["client_order_id"].startswith("DKAT")
    assert response["orders"]["stop"]["client_order_id"].startswith("DKAT")

    assert buy["combo_type"] == "NORMAL"
    assert buy["side"] == "BUY"
    assert buy["order_type"] == "LIMIT"
    assert buy["quantity"] == "7"
    assert buy["limit_price"] == "100.00"
    assert buy["support_trading_session"] == "ALL"

    target, stop = exit_place["new_orders"]
    assert target["combo_type"] == "STOP_PROFIT"
    assert target["side"] == "SELL"
    assert target["order_type"] == "LIMIT"
    assert target["quantity"] == "7"
    assert target["limit_price"] == "105.00"
    assert stop["combo_type"] == "STOP_LOSS"
    assert stop["side"] == "SELL"
    assert stop["order_type"] == "STOP_LOSS"
    assert stop["quantity"] == "7"
    assert stop["stop_price"] == "95.00"


def test_buy_entry_payload_uses_market_order_during_regular_market(monkeypatch):
    monkeypatch.setattr(WebullService, "_is_regular_market_open", classmethod(lambda cls: True))

    payload = WebullService._buy_entry_order_payload(
        symbol="AAOI",
        quantity="7",
        client_order_id="client-1",
        limit_price=100,
    )

    assert payload["order_type"] == "MARKET"
    assert payload["support_trading_session"] == "CORE"
    assert "limit_price" not in payload


def test_buy_entry_payload_uses_limit_order_outside_regular_market(monkeypatch):
    monkeypatch.setattr(WebullService, "_is_regular_market_open", classmethod(lambda cls: False))

    payload = WebullService._buy_entry_order_payload(
        symbol="AAOI",
        quantity="7",
        client_order_id="client-1",
        limit_price=100,
    )

    assert payload["order_type"] == "LIMIT"
    assert payload["support_trading_session"] == "ALL"
    assert payload["limit_price"] == "100.00"


def test_regular_market_open_uses_new_york_trading_hours():
    assert WebullService._is_regular_market_open(datetime.fromisoformat("2026-07-08T09:29:59-04:00")) is False
    assert WebullService._is_regular_market_open(datetime.fromisoformat("2026-07-08T09:30:00-04:00")) is True
    assert WebullService._is_regular_market_open(datetime.fromisoformat("2026-07-08T15:59:59-04:00")) is True
    assert WebullService._is_regular_market_open(datetime.fromisoformat("2026-07-08T16:00:00-04:00")) is False
    assert WebullService._is_regular_market_open(datetime.fromisoformat("2026-07-11T10:00:00-04:00")) is False


def test_auto_long_does_not_place_exits_until_buy_is_filled(monkeypatch):
    calls = []

    class FakeResponse:
        status_code = 200
        headers = {}

        def __init__(self, body=None):
            self.body = body or {"ok": True}

        def json(self):
            return self.body

    class FakeOrderV3:
        def preview_order(self, account_id, new_orders, client_combo_order_id=None):
            calls.append(("preview", len(new_orders), client_combo_order_id))
            return FakeResponse()

        def place_order(self, account_id, new_orders, client_combo_order_id=None):
            calls.append(("place", len(new_orders), client_combo_order_id))
            return FakeResponse()

        def get_order_detail(self, account_id, client_order_id):
            calls.append(("detail", client_order_id, None))
            return FakeResponse({"order_status": "SUBMITTED"})

    service = WebullService.__new__(WebullService)
    service._trade_client = lambda: SimpleNamespace(order_v3=FakeOrderV3())
    monkeypatch.setattr("app.webull_service.time.sleep", lambda _seconds: None)

    response = service.buy_with_bracket(
        account_id="acct-1",
        symbol="AAOI",
        quantity=7,
        entry_price=100,
        stop_price=95,
        target_price=105,
    )

    assert response["ok"] is False
    assert response["stage"] == "buy_fill_timeout"
    assert response["buy_fill"]["status"] == "SUBMITTED"
    assert response["exit_preview"] is None
    assert response["exit_place"] is None
    assert calls[:2] == [("preview", 1, None), ("place", 1, None)]
    assert len([call for call in calls if call[0] == "detail"]) == 20
    assert not any(call[0] in {"preview", "place"} and call[1] == 2 for call in calls)


def test_auto_long_uses_filled_quantity_for_exits(monkeypatch):
    captured = {}

    class FakeResponse:
        status_code = 200
        headers = {}

        def __init__(self, body=None):
            self.body = body or {"ok": True}

        def json(self):
            return self.body

    class FakeOrderV3:
        def preview_order(self, account_id, new_orders, client_combo_order_id=None):
            if client_combo_order_id:
                captured["exit_preview_orders"] = new_orders
            return FakeResponse()

        def place_order(self, account_id, new_orders, client_combo_order_id=None):
            if client_combo_order_id:
                captured["exit_place_orders"] = new_orders
            return FakeResponse()

        def get_order_detail(self, account_id, client_order_id):
            return FakeResponse({"order_status": "FILLED", "symbol": "AAOI", "filledQuantity": 5})

    service = WebullService.__new__(WebullService)
    service._trade_client = lambda: SimpleNamespace(order_v3=FakeOrderV3())
    monkeypatch.setattr("app.webull_service.time.sleep", lambda _seconds: None)

    response = service.buy_with_bracket(
        account_id="acct-1",
        symbol="AAOI",
        quantity=7,
        entry_price=100,
        stop_price=95,
        target_price=105,
    )

    assert response["ok"] is True
    assert response["buy_fill"]["filled_quantity"] == 5
    target, stop = captured["exit_place_orders"]
    assert target["quantity"] == "5"
    assert stop["quantity"] == "5"


def test_auto_long_rejects_exit_when_filled_symbol_does_not_match(monkeypatch):
    calls = []

    class FakeResponse:
        status_code = 200
        headers = {}

        def __init__(self, body=None):
            self.body = body or {"ok": True}

        def json(self):
            return self.body

    class FakeOrderV3:
        def preview_order(self, account_id, new_orders, client_combo_order_id=None):
            calls.append(("preview", len(new_orders), client_combo_order_id))
            return FakeResponse()

        def place_order(self, account_id, new_orders, client_combo_order_id=None):
            calls.append(("place", len(new_orders), client_combo_order_id))
            return FakeResponse()

        def get_order_detail(self, account_id, client_order_id):
            calls.append(("detail", client_order_id, None))
            return FakeResponse({"order_status": "FILLED", "symbol": "MSFT", "filledQuantity": 7})

    service = WebullService.__new__(WebullService)
    service._trade_client = lambda: SimpleNamespace(order_v3=FakeOrderV3())
    monkeypatch.setattr("app.webull_service.time.sleep", lambda _seconds: None)

    response = service.buy_with_bracket(
        account_id="acct-1",
        symbol="AAOI",
        quantity=7,
        entry_price=100,
        stop_price=95,
        target_price=105,
    )

    assert response["ok"] is False
    assert response["stage"] == "buy_fill_symbol_mismatch"
    assert response["buy_fill"]["symbol"] == "MSFT"
    assert response["exit_preview"] is None
    assert response["exit_place"] is None
    assert not any(call[0] in {"preview", "place"} and call[1] == 2 for call in calls)


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


def test_auto_trade_orders_buckets_buy_sell_open_and_filled(monkeypatch):
    service = WebullService.__new__(WebullService)
    captured = {}
    today = date.today().isoformat()
    yesterday = (date.today() - timedelta(days=1)).isoformat()

    def fake_order_history(account_id, page_size=50, days=30):
        captured["history_days"] = days
        return {
            "ok": True,
            "data": {
                "orders": [
                    {
                        "clientOrderId": "DKAT-buy-1",
                        "symbol": "AAOI",
                        "side": "BUY",
                        "orderStatus": "FILLED",
                        "orderType": "MARKET",
                        "quantity": "7",
                        "filledQuantity": "7",
                        "createdAt": f"{today}T10:00:00",
                    },
                    {
                        "clientOrderId": "DKAT-sell-1",
                        "symbol": "AAOI",
                        "side": "SELL",
                        "orderStatus": "FILLED",
                        "orderType": "LIMIT",
                        "quantity": "7",
                        "filledQuantity": "7",
                        "filledTime": f"{today}T10:30:00",
                    },
                    {
                        "clientOrderId": "manual-buy-1",
                        "symbol": "NVDA",
                        "side": "BUY",
                        "orderStatus": "FILLED",
                        "orderType": "MARKET",
                        "quantity": "1",
                        "filledQuantity": "1",
                        "createdAt": f"{today}T11:00:00",
                    },
                    {
                        "clientOrderId": "DKAT-old-buy-1",
                        "symbol": "MSFT",
                        "side": "BUY",
                        "orderStatus": "FILLED",
                        "orderType": "MARKET",
                        "quantity": "1",
                        "filledQuantity": "1",
                        "createdAt": f"{yesterday}T10:00:00",
                    },
                ]
            },
        }

    def fake_open_orders(account_id, page_size=50):
        return {
            "ok": True,
            "data": [
                {
                    "clientOrderId": "DKAT-stop-1",
                    "symbol": "AAOI",
                    "side": "SELL",
                    "orderStatus": "SUBMITTED",
                    "orderType": "STOP_LOSS",
                    "quantity": "7",
                    "stopPrice": "95",
                    "placedTime": f"{today}T10:31:00",
                },
                {
                    "clientOrderId": "DKAT-old-stop-1",
                    "symbol": "MSFT",
                    "side": "SELL",
                    "orderStatus": "SUBMITTED",
                    "orderType": "STOP_LOSS",
                    "quantity": "1",
                    "stopPrice": "400",
                    "placedTime": f"{yesterday}T10:31:00",
                }
            ],
        }

    service.order_history = fake_order_history
    service.open_orders = fake_open_orders
    monkeypatch.setattr("app.webull_service.time.sleep", lambda _seconds: None)

    response = service.auto_trade_orders("acct-1")

    assert response["ok"] is True
    assert captured["history_days"] == 1
    assert response["trade_date"] == today
    assert response["counts"] == {"buy": 1, "sell": 2, "open": 1, "filled": 2}
    assert [order["client_order_id"] for order in response["buckets"]["buy"]] == ["DKAT-buy-1"]
    assert {order["client_order_id"] for order in response["buckets"]["sell"]} == {"DKAT-sell-1", "DKAT-stop-1"}
    assert [order["client_order_id"] for order in response["buckets"]["open"]] == ["DKAT-stop-1"]
    assert {order["client_order_id"] for order in response["buckets"]["filled"]} == {"DKAT-buy-1", "DKAT-sell-1"}
    assert all(order["client_order_id"].startswith("DKAT") for order in response["orders"])
