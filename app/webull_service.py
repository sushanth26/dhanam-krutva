from __future__ import annotations

import contextlib
import io
import json
import logging
import time
import uuid
from datetime import date, datetime, time as datetime_time, timedelta
from typing import Any, Callable
from zoneinfo import ZoneInfo

from webull.core.client import ApiClient
from webull.core.exception.exceptions import ClientException, ServerException
from webull.data.data_client import DataClient
from webull.trade.trade_client import TradeClient

from app.config import Settings


class WebullConfigurationError(RuntimeError):
    pass


AUTO_TRADE_CLIENT_ORDER_PREFIX = "DKAT"
MARKET_TIMEZONE = ZoneInfo("America/New_York")
VERIFY_FAILURE_ERROR_CODES = {"VERIFY_FAILURE_EXCEED_LIMIT"}
RATE_LIMIT_ERROR_CODES = {"TOO_MANY_REQUESTS"}


class WebullService:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._client: TradeClient | None = None
        self._data_client: DataClient | None = None

    def status(self) -> dict[str, Any]:
        return {
            "configured": self.settings.configured,
            "environment": self.settings.environment,
            "region": self.settings.region,
            "endpoint": self.settings.endpoint,
            "data_mode": "live" if self.settings.environment == "prod" else "test",
            "auth_enabled": self.settings.auth_enabled,
            "webull_guard_enabled": self.settings.webull_guard_enabled,
            "webull_guard": self._guard_status(),
        }

    def account_list(self) -> dict[str, Any]:
        return self._call(lambda: self._trade_client().account_v2.get_account_list())

    def account_balance(self, account_id: str) -> dict[str, Any]:
        return self._call(lambda: self._trade_client().account_v2.get_account_balance(account_id))

    def account_positions(self, account_id: str) -> dict[str, Any]:
        return self._call(lambda: self._trade_client().account_v2.get_account_position(account_id))

    def order_history(self, account_id: str, page_size: int = 10, days: int = 30) -> dict[str, Any]:
        end_date = date.today()
        start_date = end_date - timedelta(days=max(1, days - 1))
        return self._call(
            lambda: self._trade_client().order_v2.get_order_history(
                account_id=account_id,
                page_size=page_size,
                start_date=start_date.isoformat(),
                end_date=end_date.isoformat(),
            )
        )

    def open_orders(self, account_id: str, page_size: int = 50) -> dict[str, Any]:
        return self._call(lambda: self._trade_client().order_v3.get_order_open(account_id, page_size=page_size))

    def order_detail(self, account_id: str, client_order_id: str) -> dict[str, Any]:
        return self._call(lambda: self._trade_client().order_v3.get_order_detail(account_id, client_order_id))

    def auto_trade_orders(self, account_id: str, page_size: int = 50, days: int = 1) -> dict[str, Any]:
        trade_date = date.today()
        history = self.order_history(account_id, page_size=page_size, days=days)
        if not history.get("ok"):
            return {**history, "orders": [], "buckets": self._empty_order_buckets(), "counts": self._empty_order_counts()}
        time.sleep(1.1)
        open_orders = self.open_orders(account_id, page_size=page_size)
        if not open_orders.get("ok"):
            return {**open_orders, "orders": [], "buckets": self._empty_order_buckets(), "counts": self._empty_order_counts()}
        history_orders = self._normalized_order_records(history.get("data"), source="history")
        open_order_records = self._normalized_order_records(open_orders.get("data"), source="open")
        history_trade_date = self._history_trade_date(history_orders, trade_date)
        selected_history_orders = [order for order in history_orders if self._is_order_on_date(order, history_trade_date)]
        selected_open_orders = [order for order in open_order_records if self._is_order_on_date(order, trade_date)]
        orders = self._dedupe_orders([*selected_open_orders, *selected_history_orders])
        buckets = {
            "buy": [order for order in orders if order.get("side") == "BUY"],
            "sell": [order for order in orders if order.get("side") == "SELL"],
            "open": [order for order in orders if self._is_open_order_status(order.get("status"))],
            "filled": [order for order in orders if self._is_filled_order_status(order.get("status"))],
        }
        return {
            "ok": bool(history.get("ok") or open_orders.get("ok")),
            "account_id": account_id,
            "trade_date": trade_date.isoformat(),
            "history_trade_date": history_trade_date.isoformat() if history_trade_date else None,
            "orders": orders,
            "buckets": buckets,
            "counts": {key: len(value) for key, value in buckets.items()},
            "history": history,
            "open_orders": open_orders,
        }

    def history_bars(
        self,
        symbol: str,
        category: str,
        timespan: str,
        count: str = "200",
        trading_sessions: list[str] | str | None = None,
    ) -> dict[str, Any]:
        return self._call(
            lambda: self._market_data_client().market_data.get_history_bar(
                symbol=symbol,
                category=category,
                timespan=timespan,
                count=count,
                real_time_required=True,
                trading_sessions=trading_sessions or ["RTH"],
            )
        )

    def batch_history_bars(
        self,
        symbols: list[str],
        category: str,
        timespan: str,
        count: str = "200",
        real_time_required: bool | None = True,
        trading_sessions: list[str] | str | None = None,
    ) -> dict[str, Any]:
        return self._call(
            lambda: self._market_data_client().market_data.get_batch_history_bar(
                symbols=symbols,
                category=category,
                timespan=timespan,
                count=count,
                real_time_required=real_time_required,
                trading_sessions=trading_sessions or ["RTH"],
            )
        )

    def market_snapshot(self, symbols: str | list[str], category: str) -> dict[str, Any]:
        return self._call(
            lambda: self._market_data_client().market_data.get_snapshot(
                symbols=symbols,
                category=category,
                extend_hour_required=False,
                overnight_required=False,
            )
        )

    def market_quote(self, symbol: str, category: str) -> dict[str, Any]:
        return self._call(
            lambda: self._market_data_client().market_data.get_quotes(
                symbol=symbol,
                category=category,
                depth=1,
                overnight_required=False,
            )
        )

    def live_quote(self, symbol: str, category: str) -> dict[str, Any]:
        symbol = symbol.strip().upper()
        snapshot = self.market_snapshot(symbol, category)
        quote = self.market_quote(symbol, category)
        snapshot_item = self._first_mapping(snapshot.get("data"))
        quote_item = quote.get("data") if isinstance(quote.get("data"), dict) else None

        return {
            "ok": bool(snapshot.get("ok")),
            "symbol": symbol,
            "source": "webull",
            "category": category,
            "price": self._snapshot_price(snapshot_item),
            "bid": self._first_depth_price(quote_item, "bids") or self._to_float(snapshot_item.get("bid") if snapshot_item else None),
            "bid_size": self._first_depth_size(quote_item, "bids") or self._to_float(snapshot_item.get("bid_size") if snapshot_item else None),
            "ask": self._first_depth_price(quote_item, "asks") or self._to_float(snapshot_item.get("ask") if snapshot_item else None),
            "ask_size": self._first_depth_size(quote_item, "asks") or self._to_float(snapshot_item.get("ask_size") if snapshot_item else None),
            "last_trade_time": self._parse_epoch_ms(snapshot_item.get("last_trade_time") if snapshot_item else None),
            "quote_time": self._parse_epoch_ms(
                (quote_item or {}).get("quote_time") or (snapshot_item or {}).get("quote_time")
            ),
            "snapshot": snapshot,
            "quote": quote,
        }

    def buy_order(self, account_id: str, symbol: str, limit_price: float, quantity: int = 1) -> dict[str, Any]:
        symbol = symbol.strip().upper()
        quantity = max(1, int(quantity))
        limit_price = round(float(limit_price), 2)
        client_order_id = uuid.uuid4().hex
        order = self._buy_entry_order_payload(
            symbol=symbol,
            quantity=str(quantity),
            client_order_id=client_order_id,
            limit_price=limit_price,
        )
        new_orders = [order]

        preview = self._call(lambda: self._trade_client().order_v3.preview_order(account_id, new_orders))
        if not preview.get("ok"):
            return {
                "ok": False,
                "stage": "preview",
                "symbol": symbol,
                "quantity": quantity,
                "limit_price": limit_price,
                "client_order_id": client_order_id,
                "preview": preview,
                "place": None,
            }

        time.sleep(1.1)
        place = self._call(lambda: self._trade_client().order_v3.place_order(account_id, new_orders))
        return {
            "ok": bool(place.get("ok")),
            "stage": "place",
            "symbol": symbol,
            "quantity": quantity,
            "limit_price": limit_price,
            "client_order_id": client_order_id,
            "preview": preview,
            "place": place,
        }

    def buy_one_order(self, account_id: str, symbol: str, limit_price: float) -> dict[str, Any]:
        return self.buy_order(account_id=account_id, symbol=symbol, limit_price=limit_price, quantity=1)

    def buy_with_bracket(
        self,
        account_id: str,
        symbol: str,
        quantity: int,
        entry_price: float,
        stop_price: float,
        target_price: float,
    ) -> dict[str, Any]:
        symbol = symbol.strip().upper()
        quantity = max(1, int(quantity))
        exit_combo_order_id = self._auto_trade_client_order_id()
        buy_client_order_id = self._auto_trade_client_order_id()
        target_client_order_id = self._auto_trade_client_order_id()
        stop_client_order_id = self._auto_trade_client_order_id()
        buy_orders = [
            self._buy_entry_order_payload(
                symbol=symbol,
                quantity=str(quantity),
                client_order_id=buy_client_order_id,
                limit_price=entry_price,
            )
        ]

        buy_preview = self._call(lambda: self._trade_client().order_v3.preview_order(account_id, buy_orders))
        if not buy_preview.get("ok"):
            return {
                "ok": False,
                "stage": "buy_preview",
                "symbol": symbol,
                "quantity": quantity,
                "entry_price": entry_price,
                "stop_price": stop_price,
                "target_price": target_price,
                "risk_per_share": round(abs(entry_price - stop_price), 4),
                "exit_combo_order_id": exit_combo_order_id,
                "orders": {
                    "buy": {"client_order_id": buy_client_order_id},
                    "target": {"client_order_id": target_client_order_id},
                    "stop": {"client_order_id": stop_client_order_id},
                },
                "preview": buy_preview,
                "buy_preview": buy_preview,
                "buy_place": None,
                "exit_preview": None,
                "exit_place": None,
                "place": None,
            }

        time.sleep(1.1)
        buy_place = self._call(lambda: self._trade_client().order_v3.place_order(account_id, buy_orders))
        if not buy_place.get("ok"):
            return {
                "ok": False,
                "stage": "buy_place",
                "symbol": symbol,
                "quantity": quantity,
                "entry_price": entry_price,
                "stop_price": stop_price,
                "target_price": target_price,
                "risk_per_share": round(abs(entry_price - stop_price), 4),
                "exit_combo_order_id": exit_combo_order_id,
                "orders": {
                    "buy": {"client_order_id": buy_client_order_id},
                    "target": {"client_order_id": target_client_order_id},
                    "stop": {"client_order_id": stop_client_order_id},
                },
                "preview": buy_preview,
                "buy_preview": buy_preview,
                "buy_place": buy_place,
                "exit_preview": None,
                "exit_place": None,
                "place": buy_place,
            }

        buy_fill = self._wait_for_order_fill(account_id, buy_client_order_id, expected_quantity=quantity)
        if not buy_fill.get("filled"):
            return {
                "ok": False,
                "stage": buy_fill.get("stage", "buy_not_filled"),
                "symbol": symbol,
                "quantity": quantity,
                "entry_price": entry_price,
                "stop_price": stop_price,
                "target_price": target_price,
                "risk_per_share": round(abs(entry_price - stop_price), 4),
                "exit_combo_order_id": exit_combo_order_id,
                "orders": {
                    "buy": {"client_order_id": buy_client_order_id},
                    "target": {"client_order_id": target_client_order_id},
                    "stop": {"client_order_id": stop_client_order_id},
                },
                "preview": buy_preview,
                "buy_preview": buy_preview,
                "buy_place": buy_place,
                "buy_fill": buy_fill,
                "exit_preview": None,
                "exit_place": None,
                "place": buy_place,
            }

        filled_symbol = buy_fill.get("symbol")
        if filled_symbol and filled_symbol != symbol:
            return {
                "ok": False,
                "stage": "buy_fill_symbol_mismatch",
                "symbol": symbol,
                "quantity": quantity,
                "entry_price": entry_price,
                "stop_price": stop_price,
                "target_price": target_price,
                "risk_per_share": round(abs(entry_price - stop_price), 4),
                "exit_combo_order_id": exit_combo_order_id,
                "orders": {
                    "buy": {"client_order_id": buy_client_order_id},
                    "target": {"client_order_id": target_client_order_id},
                    "stop": {"client_order_id": stop_client_order_id},
                },
                "preview": buy_preview,
                "buy_preview": buy_preview,
                "buy_place": buy_place,
                "buy_fill": buy_fill,
                "exit_preview": None,
                "exit_place": None,
                "place": buy_place,
            }

        exit_quantity = max(1, int(buy_fill.get("filled_quantity") or quantity))
        stop_orders = [
            self._stock_order_payload(
                symbol=symbol,
                quantity=str(exit_quantity),
                client_order_id=stop_client_order_id,
                side="SELL",
                order_type="STOP_LOSS",
                combo_type="STOP_LOSS",
                stop_price=stop_price,
            )
        ]
        stop_preview = self._call(lambda: self._trade_client().order_v3.preview_order(account_id, stop_orders))
        if not stop_preview.get("ok"):
            return {
                "ok": False,
                "stage": "stop_preview",
                "symbol": symbol,
                "quantity": quantity,
                "entry_price": entry_price,
                "stop_price": stop_price,
                "target_price": target_price,
                "risk_per_share": round(abs(entry_price - stop_price), 4),
                "exit_combo_order_id": exit_combo_order_id,
                "orders": {
                    "buy": {"client_order_id": buy_client_order_id},
                    "target": {"client_order_id": target_client_order_id},
                    "stop": {"client_order_id": stop_client_order_id},
                },
                "preview": stop_preview,
                "buy_preview": buy_preview,
                "buy_place": buy_place,
                "buy_fill": buy_fill,
                "stop_preview": stop_preview,
                "stop_place": None,
                "target_preview": None,
                "target_place": None,
                "exit_preview": stop_preview,
                "exit_place": None,
                "place": buy_place,
            }

        time.sleep(1.1)
        stop_place = self._call(lambda: self._trade_client().order_v3.place_order(account_id, stop_orders))
        if not stop_place.get("ok"):
            return {
                "ok": False,
                "stage": "stop_place",
                "symbol": symbol,
                "quantity": quantity,
                "entry_price": entry_price,
                "stop_price": stop_price,
                "target_price": target_price,
                "risk_per_share": round(abs(entry_price - stop_price), 4),
                "exit_combo_order_id": exit_combo_order_id,
                "orders": {
                    "buy": {"client_order_id": buy_client_order_id},
                    "target": {"client_order_id": target_client_order_id},
                    "stop": {"client_order_id": stop_client_order_id},
                },
                "preview": stop_preview,
                "buy_preview": buy_preview,
                "buy_place": buy_place,
                "buy_fill": buy_fill,
                "stop_preview": stop_preview,
                "stop_place": stop_place,
                "target_preview": None,
                "target_place": None,
                "exit_preview": stop_preview,
                "exit_place": stop_place,
                "place": stop_place,
            }

        exit_preview = {"ok": bool(stop_preview.get("ok")), "stop": stop_preview, "target": None}
        exit_place = {"ok": bool(stop_place.get("ok")), "stop": stop_place, "target": None}
        return {
            "ok": bool(stop_place.get("ok")),
            "stage": "stop_placed",
            "symbol": symbol,
            "quantity": quantity,
            "entry_price": entry_price,
            "stop_price": stop_price,
            "target_price": target_price,
            "risk_per_share": round(abs(entry_price - stop_price), 4),
            "exit_combo_order_id": exit_combo_order_id,
            "orders": {
                "buy": {"client_order_id": buy_client_order_id},
                "target": {"client_order_id": target_client_order_id},
                "stop": {"client_order_id": stop_client_order_id},
            },
            "preview": exit_preview,
            "buy_preview": buy_preview,
            "buy_place": buy_place,
            "buy_fill": buy_fill,
            "stop_preview": stop_preview,
            "stop_place": stop_place,
            "target_preview": None,
            "target_place": None,
            "exit_preview": exit_preview,
            "exit_place": exit_place,
            "place": exit_place,
        }

    def snapshot(self, account_id: str | None = None) -> dict[str, Any]:
        accounts = self.account_list()
        selected_account_id = account_id or self._first_account_id(accounts.get("data"))

        payload: dict[str, Any] = {
            "accounts": accounts,
            "selected_account_id": selected_account_id,
            "balance": None,
            "positions": None,
            "orders": None,
        }

        if selected_account_id:
            time.sleep(1.1)
            payload["balance"] = self.account_balance(selected_account_id)
            time.sleep(1.1)
            payload["positions"] = self.account_positions(selected_account_id)
            time.sleep(1.1)
            payload["orders"] = self.order_history(selected_account_id)

        return payload

    def _trade_client(self) -> TradeClient:
        if self._client:
            return self._client

        self._client = TradeClient(self._api_client())
        return self._client

    def _market_data_client(self) -> DataClient:
        if self._data_client:
            return self._data_client

        self._data_client = DataClient(self._api_client())
        return self._data_client

    def _api_client(self) -> ApiClient:
        if not self.settings.configured:
            raise WebullConfigurationError("WEBULL_APP_KEY and WEBULL_APP_SECRET are required.")

        with self._suppress_sdk_output():
            api_client = ApiClient(
                self.settings.app_key,
                self.settings.app_secret,
                self.settings.region,
                connect_timeout=5,
                timeout=20,
                auto_retry=False,
                max_retry_num=0,
            )
        api_client.add_endpoint(self.settings.region, self.settings.endpoint)
        if self.settings.access_token:
            api_client.set_token(self.settings.access_token)
        if self.settings.token_dir:
            self.settings.token_dir.mkdir(parents=True, exist_ok=True)
            with self._suppress_sdk_output():
                api_client.set_token_dir(str(self.settings.token_dir))

        # The SDK enables stdout and file logging by default. The app keeps API
        # diagnostics in structured responses instead of creating secret-adjacent logs.
        api_client._stream_logger_set = True
        api_client._file_logger_set = True
        for logger_name in ("webull.core", "webull.core.client", "webull.data", "webull.trade"):
            logger = logging.getLogger(logger_name)
            logger.handlers.clear()
            logger.propagate = False

        return api_client

    def _call(self, fn: Callable[[], Any]) -> dict[str, Any]:
        guard_response = self._guard_response()
        if guard_response:
            return guard_response

        try:
            with self._suppress_sdk_output():
                response = fn()
            body = self._response_body(response)
            return self._guarded_result({
                "ok": 200 <= response.status_code < 300,
                "status_code": response.status_code,
                "request_id": response.headers.get("x-request-id"),
                "data": body,
            })
        except ServerException as exc:
            return self._guarded_result({
                "ok": False,
                "status_code": exc.get_http_status(),
                "request_id": exc.get_request_id(),
                "error_code": exc.get_error_code(),
                "error": exc.get_error_msg() or str(exc),
            })
        except ClientException as exc:
            return self._guarded_result({
                "ok": False,
                "status_code": None,
                "request_id": None,
                "error_code": exc.get_error_code(),
                "error": exc.get_error_msg() or str(exc),
            })

    def _guarded_result(self, result: dict[str, Any]) -> dict[str, Any]:
        if result.get("ok"):
            return result
        settings = self._guard_settings()
        if not settings:
            return result

        error_code = str(result.get("error_code") or "")
        status_code = result.get("status_code")
        if error_code in VERIFY_FAILURE_ERROR_CODES:
            return self._activate_guard(result, settings.webull_verify_cooldown_seconds, "verification")
        if error_code in RATE_LIMIT_ERROR_CODES or status_code == 429:
            return self._activate_guard(result, settings.webull_rate_limit_cooldown_seconds, "rate_limit")
        return result

    def _activate_guard(self, result: dict[str, Any], cooldown_seconds: int, reason: str) -> dict[str, Any]:
        now = time.time()
        blocked_until = now + cooldown_seconds
        payload = {
            "active": True,
            "reason": reason,
            "error_code": result.get("error_code"),
            "status_code": result.get("status_code"),
            "request_id": result.get("request_id"),
            "error": result.get("error"),
            "blocked_at": datetime.fromtimestamp(now).isoformat(),
            "blocked_until": datetime.fromtimestamp(blocked_until).isoformat(),
            "blocked_until_epoch": blocked_until,
        }
        self._write_guard(payload)
        return {
            **result,
            "webull_guard_active": True,
            "webull_guard_reason": reason,
            "webull_guard_blocked_until": payload["blocked_until"],
            "message": "Webull calls have been paused to avoid extending a verification or rate-limit lockout.",
        }

    def _guard_response(self) -> dict[str, Any] | None:
        guard = self._guard_status()
        if not guard.get("active"):
            return None
        return {
            "ok": False,
            "status_code": 423,
            "request_id": None,
            "error_code": "WEBULL_GUARD_ACTIVE",
            "error": "Webull calls are paused to avoid extending a verification or rate-limit lockout.",
            "webull_guard_active": True,
            "webull_guard_reason": guard.get("reason"),
            "webull_guard_blocked_until": guard.get("blocked_until"),
        }

    def _guard_status(self) -> dict[str, Any]:
        settings = self._guard_settings()
        if not settings:
            return {"active": False}
        path = settings.webull_guard_file
        try:
            guard = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {"active": False}

        blocked_until = float(guard.get("blocked_until_epoch") or 0)
        if blocked_until <= time.time():
            return {"active": False}
        return {
            "active": True,
            "reason": guard.get("reason"),
            "blocked_until": guard.get("blocked_until"),
            "error_code": guard.get("error_code"),
            "status_code": guard.get("status_code"),
            "request_id": guard.get("request_id"),
        }

    def _write_guard(self, payload: dict[str, Any]) -> None:
        settings = self._guard_settings()
        if not settings:
            return
        path = settings.webull_guard_file
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        except OSError:
            logging.getLogger(__name__).exception("Failed to write Webull guard file")

    def _guard_settings(self) -> Settings | None:
        settings = getattr(self, "settings", None)
        if not settings or not hasattr(settings, "webull_guard_file"):
            return None
        if not getattr(settings, "webull_guard_enabled", True):
            return None
        return settings

    @staticmethod
    def _empty_order_buckets() -> dict[str, list[Any]]:
        return {"buy": [], "sell": [], "open": [], "filled": []}

    @staticmethod
    def _empty_order_counts() -> dict[str, int]:
        return {"buy": 0, "sell": 0, "open": 0, "filled": 0}

    @staticmethod
    @contextlib.contextmanager
    def _suppress_sdk_output():
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            yield

    @staticmethod
    def _stock_order_payload(
        symbol: str,
        quantity: str,
        client_order_id: str,
        side: str = "BUY",
        order_type: str = "MARKET",
        combo_type: str = "NORMAL",
        limit_price: float | None = None,
        stop_price: float | None = None,
        support_trading_session: str = "CORE",
    ) -> dict[str, str]:
        payload = {
            "combo_type": combo_type,
            "client_order_id": client_order_id,
            "symbol": symbol,
            "instrument_type": "EQUITY",
            "market": "US",
            "order_type": order_type,
            "quantity": quantity,
            "support_trading_session": support_trading_session,
            "side": side,
            "time_in_force": "DAY",
            "entrust_type": "QTY",
        }
        if limit_price is not None:
            payload["limit_price"] = f"{float(limit_price):.2f}"
        if stop_price is not None:
            payload["stop_price"] = f"{float(stop_price):.2f}"
        return payload

    @classmethod
    def _buy_entry_order_payload(
        cls,
        symbol: str,
        quantity: str,
        client_order_id: str,
        limit_price: float,
    ) -> dict[str, str]:
        return cls._stock_order_payload(
            symbol=symbol,
            quantity=quantity,
            client_order_id=client_order_id,
            order_type="LIMIT",
            limit_price=limit_price,
            support_trading_session="CORE" if cls._is_regular_market_open() else "ALL",
        )

    @classmethod
    def _is_regular_market_open(cls, now: datetime | None = None) -> bool:
        market_now = now or datetime.now(MARKET_TIMEZONE)
        if market_now.tzinfo is None:
            market_now = market_now.replace(tzinfo=MARKET_TIMEZONE)
        else:
            market_now = market_now.astimezone(MARKET_TIMEZONE)
        if market_now.weekday() >= 5:
            return False
        current_time = market_now.time()
        return datetime_time(9, 30) <= current_time < datetime_time(16, 0)

    @staticmethod
    def _response_body(response: Any) -> Any:
        try:
            return response.json()
        except ValueError:
            return response.text

    def _wait_for_order_fill(
        self,
        account_id: str,
        client_order_id: str,
        expected_quantity: int | None = None,
        max_attempts: int = 20,
        sleep_seconds: float = 1.1,
    ) -> dict[str, Any]:
        last_detail: dict[str, Any] | None = None
        for attempt in range(1, max_attempts + 1):
            detail = self.order_detail(account_id, client_order_id)
            status = self._order_status(detail.get("data"))
            filled_quantity = self._order_filled_quantity(detail.get("data"))
            symbol = self._order_symbol(detail.get("data"))
            last_detail = {
                **detail,
                "attempt": attempt,
                "order_status": status,
                "filled_quantity": filled_quantity,
                "symbol": symbol,
            }

            if not detail.get("ok"):
                history_fill = self._filled_order_from_history(account_id, client_order_id, expected_quantity)
                if history_fill:
                    return {
                        "filled": True,
                        "stage": "buy_filled_history",
                        "status": history_fill.get("status"),
                        "filled_quantity": history_fill.get("filled_quantity"),
                        "symbol": history_fill.get("symbol"),
                        "attempts": attempt,
                        "detail": last_detail,
                        "history_order": history_fill,
                    }
                return {
                    "filled": False,
                    "stage": "buy_fill_check",
                    "status": status,
                    "filled_quantity": filled_quantity,
                    "symbol": symbol,
                    "attempts": attempt,
                    "detail": last_detail,
                }
            if self._is_filled_order_status(status) or (
                expected_quantity is not None and filled_quantity is not None and filled_quantity >= expected_quantity
            ):
                return {
                    "filled": True,
                    "stage": "buy_filled",
                    "status": status,
                    "filled_quantity": filled_quantity,
                    "symbol": symbol,
                    "attempts": attempt,
                    "detail": last_detail,
                }
            if self._is_terminal_unfilled_order_status(status):
                return {
                    "filled": False,
                    "stage": "buy_not_filled",
                    "status": status,
                    "filled_quantity": filled_quantity,
                    "symbol": symbol,
                    "attempts": attempt,
                    "detail": last_detail,
                }
            if attempt < max_attempts:
                time.sleep(sleep_seconds)

        history_fill = self._filled_order_from_history(account_id, client_order_id, expected_quantity)
        if history_fill:
            return {
                "filled": True,
                "stage": "buy_filled_history",
                "status": history_fill.get("status"),
                "filled_quantity": history_fill.get("filled_quantity"),
                "symbol": history_fill.get("symbol"),
                "attempts": max_attempts,
                "detail": last_detail,
                "history_order": history_fill,
            }

        return {
            "filled": False,
            "stage": "buy_fill_timeout",
            "status": (last_detail or {}).get("order_status"),
            "filled_quantity": (last_detail or {}).get("filled_quantity"),
            "symbol": (last_detail or {}).get("symbol"),
            "attempts": max_attempts,
            "detail": last_detail,
        }

    def _filled_order_from_history(
        self,
        account_id: str,
        client_order_id: str,
        expected_quantity: int | None = None,
    ) -> dict[str, Any] | None:
        try:
            history = self.order_history(account_id, page_size=50, days=1)
        except Exception:
            return None
        if not history.get("ok"):
            return None
        for order in self._normalized_order_records(history.get("data"), source="history"):
            if order.get("client_order_id") != client_order_id:
                continue
            filled_quantity = order.get("filled_quantity")
            if self._is_filled_order_status(order.get("status")) or (
                expected_quantity is not None and filled_quantity is not None and filled_quantity >= expected_quantity
            ):
                return order
        return None

    @classmethod
    def _order_status(cls, data: Any) -> str | None:
        status = cls._find_first_value(
            data,
            (
                "order_status",
                "orderStatus",
                "status",
                "order_status_name",
                "orderStatusName",
                "status_name",
                "statusName",
                "order_status_desc",
                "orderStatusDesc",
                "status_desc",
                "statusDesc",
            ),
        )
        if status is None:
            return None
        return str(status).strip().upper().replace("_", " ")

    @classmethod
    def _order_symbol(cls, data: Any) -> str | None:
        symbol = cls._find_first_value(data, ("symbol", "ticker", "tickerSymbol", "symbolName"))
        if symbol is None:
            return None
        return str(symbol).strip().upper()

    @classmethod
    def _order_filled_quantity(cls, data: Any) -> int | None:
        value = cls._find_first_value(
            data,
            (
                "filled_quantity",
                "filledQuantity",
                "filled_qty",
                "filledQty",
                "cum_quantity",
                "cumQuantity",
                "executed_quantity",
                "executedQuantity",
                "filled",
                "totalFilledQuantity",
                "totalFilledQty",
                "cumQty",
                "executedQty",
            ),
        )
        parsed = cls._to_float(value)
        if parsed is None or parsed <= 0:
            return None
        return int(parsed)

    @classmethod
    def _normalized_order_records(cls, data: Any, source: str) -> list[dict[str, Any]]:
        output: list[dict[str, Any]] = []
        for item in cls._order_record_dicts(data):
            normalized = cls._normalized_order_record(item, source)
            if normalized:
                output.append(normalized)
        return output

    @classmethod
    def _order_record_dicts(cls, data: Any) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        if isinstance(data, list):
            for item in data:
                records.extend(cls._order_record_dicts(item))
            return records
        if not isinstance(data, dict):
            return records

        if cls._looks_like_order_record(data):
            return [data]
        for value in data.values():
            records.extend(cls._order_record_dicts(value))
        return records

    @classmethod
    def _looks_like_order_record(cls, data: dict[str, Any]) -> bool:
        fields = (
            cls._find_direct_value(data, ("symbol", "ticker", "tickerSymbol")),
            cls._find_direct_value(data, ("side", "action", "orderSide")),
            cls._find_direct_value(
                data,
                (
                    "order_status",
                    "orderStatus",
                    "status",
                    "order_status_name",
                    "orderStatusName",
                    "status_name",
                    "statusName",
                ),
            ),
            cls._find_direct_value(data, ("order_type", "orderType", "type")),
            cls._find_direct_value(
                data,
                (
                    "client_order_id",
                    "clientOrderId",
                    "clientOrderID",
                    "client_order_no",
                    "clientOrderNo",
                    "order_id",
                    "orderId",
                    "id",
                ),
            ),
        )
        return sum(value not in (None, "") for value in fields) >= 2

    @classmethod
    def _normalized_order_record(cls, data: dict[str, Any], source: str) -> dict[str, Any] | None:
        side = cls._order_side(data)
        status = cls._order_status(data)
        symbol = cls._order_symbol(data)
        order_type = cls._order_type(data)
        client_order_id = cls._find_first_value(
            data,
            ("client_order_id", "clientOrderId", "clientOrderID", "client_order_no", "clientOrderNo"),
        )
        order_id = cls._find_first_value(data, ("order_id", "orderId", "id"))
        if not any((side, status, symbol, order_type, client_order_id, order_id)):
            return None
        return {
            "symbol": symbol,
            "side": side,
            "status": status,
            "order_type": order_type,
            "quantity": cls._order_quantity(data),
            "filled_quantity": cls._order_filled_quantity(data),
            "limit_price": cls._order_price(data, ("limit_price", "limitPrice", "lmtPrice")),
            "stop_price": cls._order_price(data, ("stop_price", "stopPrice", "auxPrice")),
            "avg_price": cls._order_price(
                data,
                ("avg_price", "avgPrice", "filled_price", "filledPrice", "filledAvgPrice", "averageFilledPrice"),
            ),
            "client_order_id": str(client_order_id) if client_order_id not in (None, "") else None,
            "order_id": str(order_id) if order_id not in (None, "") else None,
            "created_at": cls._find_first_value(
                data,
                (
                    "created_at",
                    "createdAt",
                    "createTime",
                    "place_time_at",
                    "placeTimeAt",
                    "place_time",
                    "placeTime",
                    "placedTime",
                    "placed_at",
                    "submittedTime",
                    "orderTime",
                    "time",
                    "timestamp",
                ),
            ),
            "updated_at": cls._find_first_value(
                data,
                (
                    "updated_at",
                    "updatedAt",
                    "updateTime",
                    "filled_time_at",
                    "filledTimeAt",
                    "filled_time",
                    "filledTime",
                    "filled_at",
                    "transactionTime",
                    "lastUpdateTime",
                ),
            ),
            "source": source,
            "raw": data,
        }

    @classmethod
    def _order_side(cls, data: Any) -> str | None:
        side = cls._find_first_value(data, ("side", "action", "orderSide"))
        if side is None:
            return None
        normalized = str(side).strip().upper().replace("_", " ")
        if normalized in {"BUY", "SELL", "SHORT"}:
            return normalized
        return normalized or None

    @classmethod
    def _order_type(cls, data: Any) -> str | None:
        order_type = cls._find_first_value(
            data,
            ("order_type", "orderType", "type", "order_type_name", "orderTypeName"),
        )
        if order_type is None:
            return None
        return str(order_type).strip().upper().replace("_", " ")

    @classmethod
    def _order_quantity(cls, data: Any) -> int | None:
        value = cls._find_first_value(
            data,
            ("quantity", "qty", "total_quantity", "totalQuantity", "orderQuantity", "orderQty"),
        )
        parsed = cls._to_float(value)
        if parsed is None or parsed <= 0:
            return None
        return int(parsed)

    @classmethod
    def _order_price(cls, data: Any, keys: tuple[str, ...]) -> float | None:
        value = cls._find_first_value(data, keys)
        parsed = cls._to_float(value)
        if parsed is None:
            return None
        return round(parsed, 4)

    @classmethod
    def _dedupe_orders(cls, orders: list[dict[str, Any]]) -> list[dict[str, Any]]:
        output: list[dict[str, Any]] = []
        seen: set[str] = set()
        for order in orders:
            key = "|".join(
                str(order.get(item) or "")
                for item in ("client_order_id", "order_id", "symbol", "side", "status", "order_type")
            )
            if key in seen:
                continue
            seen.add(key)
            output.append(order)
        return output

    @classmethod
    def _auto_trade_client_order_id(cls) -> str:
        return f"{AUTO_TRADE_CLIENT_ORDER_PREFIX}{uuid.uuid4().hex[:28]}"

    @classmethod
    def _is_auto_trade_order(cls, order: dict[str, Any]) -> bool:
        client_order_id = str(order.get("client_order_id") or "")
        if client_order_id.startswith(AUTO_TRADE_CLIENT_ORDER_PREFIX):
            return True
        return cls._looks_like_auto_trade_exit(order)

    @staticmethod
    def _looks_like_auto_trade_exit(order: dict[str, Any]) -> bool:
        if order.get("source") != "open" or order.get("side") != "SELL":
            return False
        order_type = str(order.get("order_type") or "")
        return order.get("stop_price") is not None or order_type in {"STOP LOSS", "STOP LOSS LIMIT", "STOP_LOSS", "STOP_LOSS_LIMIT"}

    @classmethod
    def _is_order_on_date(cls, order: dict[str, Any], target_date: date) -> bool:
        dates = [
            cls._parse_order_date(order.get("created_at")),
            cls._parse_order_date(order.get("updated_at")),
        ]
        return any(parsed == target_date for parsed in dates if parsed is not None)

    @classmethod
    def _history_trade_date(cls, orders: list[dict[str, Any]], preferred_date: date) -> date:
        order_dates = [
            parsed
            for order in orders
            for parsed in (cls._parse_order_date(order.get("created_at")), cls._parse_order_date(order.get("updated_at")))
            if parsed is not None
        ]
        if preferred_date in order_dates:
            return preferred_date
        return max(order_dates, default=preferred_date)

    @staticmethod
    def _parse_order_date(value: Any) -> date | None:
        if value in (None, ""):
            return None
        if isinstance(value, date) and not isinstance(value, datetime):
            return value
        if isinstance(value, datetime):
            return value.date()
        if isinstance(value, (int, float)):
            timestamp = float(value)
            if timestamp > 10_000_000_000:
                timestamp /= 1000
            try:
                return datetime.fromtimestamp(timestamp).date()
            except (OSError, OverflowError, ValueError):
                return None

        text = str(value).strip()
        if not text:
            return None
        if text.replace(".", "", 1).isdigit():
            try:
                timestamp = float(text)
                if timestamp > 10_000_000_000:
                    timestamp /= 1000
                return datetime.fromtimestamp(timestamp).date()
            except (OSError, OverflowError, ValueError):
                return None
        normalized = text.replace("Z", "+00:00")
        try:
            return datetime.fromisoformat(normalized).date()
        except ValueError:
            pass
        for pattern in ("%Y-%m-%d", "%Y-%m-%d %H:%M:%S", "%m/%d/%Y %H:%M:%S", "%m/%d/%Y"):
            try:
                return datetime.strptime(text, pattern).date()
            except ValueError:
                continue
        return None

    @staticmethod
    def _is_filled_order_status(status: str | None) -> bool:
        return status in {
            "FILLED",
            "FULLY FILLED",
            "FILLED ALL",
            "ALL FILLED",
            "EXECUTED",
            "DONE",
            "COMPLETE",
            "COMPLETED",
        }

    @staticmethod
    def _is_open_order_status(status: str | None) -> bool:
        return status in {
            "SUBMITTED",
            "PENDING",
            "WORKING",
            "PARTIAL FILLED",
            "PARTIALLY FILLED",
            "PARTIALFILLED",
            "NEW",
            "OPEN",
            "QUEUED",
            "ACCEPTED",
            "LIVE",
        }

    @staticmethod
    def _is_terminal_unfilled_order_status(status: str | None) -> bool:
        return status in {"CANCELLED", "CANCELED", "FAILED", "REJECTED", "EXPIRED", "VOIDED"}

    @classmethod
    def _find_first_value(cls, data: Any, keys: tuple[str, ...]) -> Any:
        if isinstance(data, dict):
            for key in keys:
                if data.get(key) not in (None, ""):
                    return data[key]
            for value in data.values():
                found = cls._find_first_value(value, keys)
                if found not in (None, ""):
                    return found
        if isinstance(data, list):
            for item in data:
                found = cls._find_first_value(item, keys)
                if found not in (None, ""):
                    return found
        return None

    @staticmethod
    def _find_direct_value(data: dict[str, Any], keys: tuple[str, ...]) -> Any:
        for key in keys:
            if data.get(key) not in (None, ""):
                return data[key]
        return None

    @classmethod
    def _snapshot_price(cls, data: Any) -> float | None:
        if isinstance(data, dict):
            for key in ("last_price", "lastPrice", "price", "close", "pPrice", "trade_price", "tradePrice"):
                parsed = cls._to_float(data.get(key))
                if parsed is not None:
                    return parsed
            for value in data.values():
                parsed = cls._snapshot_price(value)
                if parsed is not None:
                    return parsed
        if isinstance(data, list):
            for item in data:
                parsed = cls._snapshot_price(item)
                if parsed is not None:
                    return parsed
        return None

    @classmethod
    def _first_mapping(cls, data: Any) -> dict[str, Any] | None:
        if isinstance(data, dict):
            return data
        if isinstance(data, list):
            for item in data:
                if isinstance(item, dict):
                    return item
        return None

    @classmethod
    def _first_depth_price(cls, data: dict[str, Any] | None, side: str) -> float | None:
        levels = data.get(side) if data else None
        if isinstance(levels, list) and levels and isinstance(levels[0], dict):
            return cls._to_float(levels[0].get("price"))
        return None

    @classmethod
    def _first_depth_size(cls, data: dict[str, Any] | None, side: str) -> float | None:
        levels = data.get(side) if data else None
        if isinstance(levels, list) and levels and isinstance(levels[0], dict):
            return cls._to_float(levels[0].get("size"))
        return None

    @staticmethod
    def _parse_epoch_ms(value: Any) -> str | None:
        parsed = WebullService._to_float(value)
        if parsed is None:
            return str(value) if value else None
        if parsed > 10_000_000_000:
            parsed = parsed / 1000
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(parsed))

    @staticmethod
    def _to_float(value: Any) -> float | None:
        if value in (None, ""):
            return None
        try:
            return float(str(value).replace(",", ""))
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _first_account_id(data: Any) -> str | None:
        if isinstance(data, dict):
            for key in ("account_id", "accountId", "id"):
                value = data.get(key)
                if value:
                    return str(value)
            for value in data.values():
                found = WebullService._first_account_id(value)
                if found:
                    return found

        if isinstance(data, list):
            for item in data:
                found = WebullService._first_account_id(item)
                if found:
                    return found

        return None
