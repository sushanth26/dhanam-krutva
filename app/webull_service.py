from __future__ import annotations

import contextlib
import io
import logging
import time
import uuid
from datetime import date, timedelta
from typing import Any, Callable

from webull.core.client import ApiClient
from webull.core.exception.exceptions import ClientException, ServerException
from webull.data.data_client import DataClient
from webull.trade.trade_client import TradeClient

from app.config import Settings


class WebullConfigurationError(RuntimeError):
    pass


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
        }

    def account_list(self) -> dict[str, Any]:
        return self._call(lambda: self._trade_client().account_v2.get_account_list())

    def account_balance(self, account_id: str) -> dict[str, Any]:
        return self._call(lambda: self._trade_client().account_v2.get_account_balance(account_id))

    def account_positions(self, account_id: str) -> dict[str, Any]:
        return self._call(lambda: self._trade_client().account_v2.get_account_position(account_id))

    def order_history(self, account_id: str, page_size: int = 10, days: int = 30) -> dict[str, Any]:
        end_date = date.today()
        start_date = end_date - timedelta(days=days)
        return self._call(
            lambda: self._trade_client().order_v2.get_order_history(
                account_id=account_id,
                page_size=page_size,
                start_date=start_date.isoformat(),
                end_date=end_date.isoformat(),
            )
        )

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

    def buy_one_market_order(self, account_id: str, symbol: str) -> dict[str, Any]:
        symbol = symbol.strip().upper()
        preview_order = self._stock_order_payload(symbol=symbol, quantity="1")
        place_order = {
            **preview_order,
            "client_order_id": uuid.uuid4().hex,
        }

        preview = self._call(lambda: self._trade_client().order_v2.preview_order(account_id, preview_order))
        if not preview.get("ok"):
            return {
                "ok": False,
                "stage": "preview",
                "symbol": symbol,
                "quantity": 1,
                "preview": preview,
                "place": None,
            }

        time.sleep(1.1)
        place = self._call(lambda: self._trade_client().order_v2.place_order(account_id, place_order))
        return {
            "ok": bool(place.get("ok")),
            "stage": "place",
            "symbol": symbol,
            "quantity": 1,
            "client_order_id": place_order["client_order_id"],
            "preview": preview,
            "place": place,
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
                auto_retry=True,
                max_retry_num=1,
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
        try:
            with self._suppress_sdk_output():
                response = fn()
            body = self._response_body(response)
            return {
                "ok": 200 <= response.status_code < 300,
                "status_code": response.status_code,
                "request_id": response.headers.get("x-request-id"),
                "data": body,
            }
        except ServerException as exc:
            return {
                "ok": False,
                "status_code": exc.get_http_status(),
                "request_id": exc.get_request_id(),
                "error_code": exc.get_error_code(),
                "error": exc.get_error_msg() or str(exc),
            }
        except ClientException as exc:
            return {
                "ok": False,
                "status_code": None,
                "request_id": None,
                "error_code": exc.get_error_code(),
                "error": exc.get_error_msg() or str(exc),
            }

    @staticmethod
    @contextlib.contextmanager
    def _suppress_sdk_output():
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            yield

    @staticmethod
    def _stock_order_payload(symbol: str, quantity: str) -> dict[str, str]:
        return {
            "symbol": symbol,
            "instrument_type": "EQUITY",
            "market": "US",
            "order_type": "MARKET",
            "quantity": quantity,
            "support_trading_session": "N",
            "side": "BUY",
            "time_in_force": "DAY",
            "entrust_type": "QTY",
        }

    @staticmethod
    def _response_body(response: Any) -> Any:
        try:
            return response.json()
        except ValueError:
            return response.text

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
