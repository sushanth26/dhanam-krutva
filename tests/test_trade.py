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


def test_approved_auto_trade_symbols_skip_disabled_watchlists(tmp_path, monkeypatch):
    watchlist_file = tmp_path / "watchlists.json"
    WatchlistStore(watchlist_file).replace(
        [
            {"id": "og", "symbols": ["BE"]},
            {"name": "Daily", "symbols": ["PLTR", "AAOI"], "auto_trade_enabled": False},
        ]
    )
    monkeypatch.setattr(trade, "get_settings", lambda: SimpleNamespace(watchlist_file=watchlist_file))

    assert "BE" in trade.approved_auto_trade_symbols()
    assert "PLTR" not in trade.approved_auto_trade_symbols()
    assert "AAOI" not in trade.approved_auto_trade_symbols()


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


def test_auto_long_rejects_symbols_from_auto_trade_disabled_watchlists(tmp_path, monkeypatch):
    watchlist_file = tmp_path / "watchlists.json"
    WatchlistStore(watchlist_file).replace(
        [
            {"id": "og", "symbols": ["BE"]},
            {"name": "Daily", "symbols": ["AAOI"], "auto_trade_enabled": False},
        ]
    )
    monkeypatch.setattr(trade, "get_settings", lambda: SimpleNamespace(watchlist_file=watchlist_file))

    try:
        trade.auto_buy_with_bracket(
            trade.AutoLongRequest(account_id="acct-1", symbol="AAOI", quantity=7, entry_price=100, stop_price=95, target_price=105)
        )
    except HTTPException as exc:
        assert exc.status_code == 400
        assert exc.detail == "Symbol is not in the approved strategy watchlist."
    else:
        raise AssertionError("auto long should reject symbols from disabled watchlists")


def test_auto_long_buys_first_then_places_stop_only_for_full_size(monkeypatch):
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
            order = new_orders[0]
            key = "buy_preview"
            if order.get("order_type") == "STOP_LOSS":
                key = "stop_preview"
            elif order.get("side") == "SELL":
                key = "target_preview"
            captured[key] = {
                "account_id": account_id,
                "new_orders": new_orders,
                "client_combo_order_id": client_combo_order_id,
            }
            return FakeResponse()

        def place_order(self, account_id, new_orders, client_combo_order_id=None):
            calls.append(("place", len(new_orders), client_combo_order_id))
            order = new_orders[0]
            key = "buy_place"
            if order.get("order_type") == "STOP_LOSS":
                key = "stop_place"
            elif order.get("side") == "SELL":
                key = "target_place"
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
    stop_place = captured["stop_place"]
    buy = buy_place["new_orders"][0]
    assert response["ok"] is True
    assert response["stage"] == "stop_placed"
    assert response["quantity"] == 7
    assert response["buy_fill"]["symbol"] == "AAOI"
    assert response["buy_fill"]["filled_quantity"] == 7
    assert calls == [
        ("preview", 1, None),
        ("place", 1, None),
        ("detail", response["orders"]["buy"]["client_order_id"], None),
        ("preview", 1, None),
        ("place", 1, None),
    ]
    assert response["orders"]["buy"]["client_order_id"].startswith("DKAT")
    assert response["orders"]["target"]["client_order_id"].startswith("DKAT")
    assert response["orders"]["stop"]["client_order_id"].startswith("DKAT")
    assert response["target_preview"] is None
    assert response["target_place"] is None

    assert buy["combo_type"] == "NORMAL"
    assert buy["side"] == "BUY"
    assert buy["order_type"] == "LIMIT"
    assert buy["quantity"] == "7"
    assert buy["limit_price"] == "100.00"
    assert buy["support_trading_session"] == "ALL"

    stop = stop_place["new_orders"][0]
    assert stop["combo_type"] == "STOP_LOSS"
    assert stop["side"] == "SELL"
    assert stop["order_type"] == "STOP_LOSS"
    assert stop["quantity"] == "7"
    assert stop["stop_price"] == "95.00"


def test_buy_entry_payload_uses_core_limit_order_during_regular_market(monkeypatch):
    monkeypatch.setattr(WebullService, "_is_regular_market_open", classmethod(lambda cls: True))

    payload = WebullService._buy_entry_order_payload(
        symbol="AAOI",
        quantity="7",
        client_order_id="client-1",
        limit_price=100,
    )

    assert payload["order_type"] == "LIMIT"
    assert payload["support_trading_session"] == "CORE"
    assert payload["limit_price"] == "100.00"


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


def test_auto_long_places_exits_when_history_reports_fill_after_detail_timeout(monkeypatch):
    captured = {}

    class FakeResponse:
        status_code = 200
        headers = {}

        def __init__(self, body=None):
            self.body = body or {"ok": True}

        def json(self):
            return self.body

    class FakeOrderV2:
        def get_order_history(self, account_id, page_size, start_date, end_date):
            return FakeResponse(
                {
                    "orders": [
                        {
                            "clientOrderId": captured["buy_client_order_id"],
                            "symbol": "AAOI",
                            "side": "BUY",
                            "orderStatusDesc": "Filled_All",
                            "orderType": "MARKET",
                            "quantity": "7",
                            "filledQuantity": "7",
                        }
                    ]
                }
            )

    class FakeOrderV3:
        def preview_order(self, account_id, new_orders, client_combo_order_id=None):
            return FakeResponse()

        def place_order(self, account_id, new_orders, client_combo_order_id=None):
            order = new_orders[0]
            if order.get("side") == "BUY":
                captured["buy_client_order_id"] = new_orders[0]["client_order_id"]
            elif order.get("order_type") == "STOP_LOSS":
                captured["stop_place_orders"] = new_orders
            else:
                captured["target_place_orders"] = new_orders
            return FakeResponse()

        def get_order_detail(self, account_id, client_order_id):
            return FakeResponse({"orderStatus": "SUBMITTED"})

    service = WebullService.__new__(WebullService)
    service._trade_client = lambda: SimpleNamespace(order_v2=FakeOrderV2(), order_v3=FakeOrderV3())
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
    assert response["stage"] == "stop_placed"
    assert response["buy_fill"]["stage"] == "buy_filled_history"
    assert response["buy_fill"]["filled_quantity"] == 7
    stop = captured["stop_place_orders"][0]
    assert stop["side"] == "SELL"
    assert "target_place_orders" not in captured


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
            if new_orders[0].get("order_type") == "STOP_LOSS":
                captured["stop_preview_orders"] = new_orders
            return FakeResponse()

        def place_order(self, account_id, new_orders, client_combo_order_id=None):
            if new_orders[0].get("order_type") == "STOP_LOSS":
                captured["stop_place_orders"] = new_orders
            elif new_orders[0].get("side") == "SELL":
                captured["target_place_orders"] = new_orders
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
    stop = captured["stop_place_orders"][0]
    assert stop["quantity"] == "5"
    assert "target_place_orders" not in captured


def test_auto_long_places_exits_when_detail_reports_full_quantity_without_filled_status(monkeypatch):
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
            return FakeResponse()

        def place_order(self, account_id, new_orders, client_combo_order_id=None):
            if new_orders[0].get("order_type") == "STOP_LOSS":
                captured["stop_place_orders"] = new_orders
            elif new_orders[0].get("side") == "SELL":
                captured["target_place_orders"] = new_orders
            return FakeResponse()

        def get_order_detail(self, account_id, client_order_id):
            return FakeResponse({"orderStatus": "PARTIAL_FILLED", "symbol": "AAOI", "filled": "7"})

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
    assert response["stage"] == "stop_placed"
    assert response["buy_fill"]["filled_quantity"] == 7
    assert captured["stop_place_orders"][0]["side"] == "SELL"
    assert "target_place_orders" not in captured


def test_filled_status_accepts_common_broker_variants():
    assert WebullService._is_filled_order_status("FULLY FILLED") is True
    assert WebullService._is_filled_order_status("EXECUTED") is True
    assert WebullService._is_filled_order_status("COMPLETED") is True


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
    assert response["counts"] == {"buy": 2, "sell": 2, "open": 1, "filled": 3}
    assert {order["client_order_id"] for order in response["buckets"]["buy"]} == {"DKAT-buy-1", "manual-buy-1"}
    assert {order["client_order_id"] for order in response["buckets"]["sell"]} == {"DKAT-sell-1", None}
    assert [order["stop_price"] for order in response["buckets"]["open"]] == [95]
    assert {order["client_order_id"] for order in response["buckets"]["filled"]} == {"DKAT-buy-1", "DKAT-sell-1", "manual-buy-1"}


def test_auto_trade_orders_falls_back_to_todays_webull_history_shape(monkeypatch):
    service = WebullService.__new__(WebullService)
    today = date.today().isoformat()
    yesterday = (date.today() - timedelta(days=1)).isoformat()

    def fake_order_history(account_id, page_size=50, days=30):
        return {
            "ok": True,
            "data": {
                "orders": [
                    {
                        "client_order_id": "webull-random-buy",
                        "order_id": "order-1",
                        "symbol": "AVGO",
                        "side": "BUY",
                        "status": "FILLED",
                        "order_type": "MARKET",
                        "total_quantity": "1",
                        "filled_quantity": "1",
                        "place_time": f"{today}T10:00:00",
                        "filled_time": f"{today}T10:00:01",
                    },
                    {
                        "client_order_id": "DKAT-random-sell",
                        "order_id": "order-3",
                        "symbol": "AVGO",
                        "side": "SELL",
                        "status": "FILLED",
                        "order_type": "LIMIT",
                        "total_quantity": "1",
                        "filled_quantity": "1",
                        "place_time": f"{today}T10:05:00",
                        "filled_time": f"{today}T10:05:01",
                    },
                    {
                        "client_order_id": "webull-random-old",
                        "order_id": "order-2",
                        "symbol": "MSFT",
                        "side": "BUY",
                        "status": "FILLED",
                        "order_type": "MARKET",
                        "total_quantity": "1",
                        "filled_quantity": "1",
                        "place_time": f"{yesterday}T10:00:00",
                        "filled_time": f"{yesterday}T10:00:01",
                    },
                ]
            },
        }

    service.order_history = fake_order_history
    service.open_orders = lambda account_id, page_size=50: {"ok": True, "data": []}
    monkeypatch.setattr("app.webull_service.time.sleep", lambda _seconds: None)

    response = service.auto_trade_orders("acct-1")

    assert response["counts"] == {"buy": 1, "sell": 1, "open": 0, "filled": 2}
    assert {order["client_order_id"] for order in response["orders"]} == {"webull-random-buy", "DKAT-random-sell"}
    assert response["orders"][0]["quantity"] == 1
    assert response["orders"][0]["created_at"] == f"{today}T10:00:00"


def test_auto_trade_orders_uses_latest_history_date_when_today_has_only_open_orders(monkeypatch):
    service = WebullService.__new__(WebullService)
    today = date.today().isoformat()
    yesterday = (date.today() - timedelta(days=1)).isoformat()

    service.order_history = lambda account_id, page_size=50, days=30: {
        "ok": True,
        "data": {
            "orders": [
                {
                    "client_order_id": "history-buy",
                    "symbol": "BE",
                    "side": "BUY",
                    "status": "FILLED",
                    "order_type": "LIMIT",
                    "total_quantity": "20",
                    "filled_quantity": "20",
                    "place_time_at": f"{yesterday}T13:46:40.567Z",
                    "filled_time_at": f"{yesterday}T13:46:50.173Z",
                }
            ]
        },
    }
    service.open_orders = lambda account_id, page_size=50: {
        "ok": True,
        "data": [
            {
                "client_order_id": "open-stop",
                "symbol": "BE",
                "side": "SELL",
                "status": "SUBMITTED",
                "order_type": "STOP_LOSS",
                "total_quantity": "5",
                "place_time_at": f"{today}T13:48:44.375Z",
                "stop_price": "255.37",
            }
        ],
    }
    monkeypatch.setattr("app.webull_service.time.sleep", lambda _seconds: None)

    response = service.auto_trade_orders("acct-1")

    assert response["trade_date"] == today
    assert response["history_trade_date"] == yesterday
    assert response["counts"] == {"buy": 1, "sell": 1, "open": 1, "filled": 1}
    assert {order["client_order_id"] for order in response["orders"]} == {"history-buy", "open-stop"}
