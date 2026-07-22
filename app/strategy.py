from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from webull.data.common.category import Category
from webull.data.common.timespan import Timespan

from app.config import get_settings
from app.webull_service import WebullService


WATCHLIST = [
    "BE", "GLW", "MRVL", "CRDO",
    "DRAM", "MU", "SNDK", "STX", "WDC",
    "AAOI", "COHR", "LITE",
    "ASTS", "RKLB",
    "APLD", "CIFR", "CRWV", "HUT", "IREN", "NBIS", "WULF",
    "AMD", "ARM", "AVGO", "DELL", "INTC",
    "APP", "GEV", "VRT",
    "MP", "USAR",
    "LLY", "PLTR", "RDDT",
]

MARKET_TIMEZONE = ZoneInfo("America/New_York")


@dataclass(frozen=True)
class StrategyConfig:
    timeframe_minutes: int = 10
    entry_quantity: int = 1
    max_trades_per_day: int = 3
    stop_loss_offset: float = 2.0
    fast_cloud: tuple[int, int] = (5, 12)
    slow_cloud: tuple[int, int] = (34, 50)
    source_timespan: str = Timespan.M5.name
    source_bar_count: str = "220"


def run_dry_run(symbols: list[str] | None = None) -> dict[str, Any]:
    config = StrategyConfig()
    service = WebullService(get_settings())
    selected_symbols = symbols or WATCHLIST
    results = []
    data_errors = []
    snapshots = load_snapshots(service, selected_symbols)

    for symbol in selected_symbols:
        bars_response = service.history_bars(
            symbol=symbol,
            category=Category.US_STOCK.name,
            timespan=config.source_timespan,
            count=config.source_bar_count,
        )
        if not bars_response.get("ok"):
            data_errors.append({"symbol": symbol, "error": bars_response})
            if bars_response.get("status_code") in (401, 403):
                break
            continue

        candles = normalize_bars(bars_response.get("data"))
        ten_minute_candles = aggregate_to_10_minute(candles)
        results.append(evaluate_symbol(symbol, ten_minute_candles, config, snapshots.get(symbol)))

    return {
        "mode": "dry_run",
        "status": "blocked" if data_errors and not results else "ok",
        "strategy": {
            "timeframe": "10m",
            "fast_cloud": "EMA 5/12",
            "slow_cloud": "EMA 34/50",
            "entry": "fast cloud above slow cloud and price touches slow cloud",
            "stop_loss": "$2 below 34/50 cloud",
            "target": "high of day",
            "quantity": config.entry_quantity,
            "max_trades_per_day": config.max_trades_per_day,
        },
        "symbols": selected_symbols,
        "results": results,
        "signals": [result for result in results if result["signal"]],
        "data_errors": data_errors,
    }


def evaluate_symbol(symbol: str, candles: list[dict[str, Any]], config: StrategyConfig, snapshot: dict[str, Any] | None = None) -> dict[str, Any]:
    closes = [candle["close"] for candle in candles]
    if len(closes) < max(config.slow_cloud) + 2:
        return {
            "symbol": symbol,
            "signal": False,
            "reason": "Not enough 10-minute bars for EMA 50.",
            "bar_count": len(closes),
        }

    ema5 = ema(closes, 5)
    ema12 = ema(closes, 12)
    ema34 = ema(closes, 34)
    ema50 = ema(closes, 50)

    latest = candles[-1]
    fast_bottom = min(ema5[-1], ema12[-1])
    slow_top = max(ema34[-1], ema50[-1])
    slow_bottom = min(ema34[-1], ema50[-1])

    fast_cloud_above_slow_cloud = fast_bottom > slow_top
    touched_slow_cloud = latest["low"] <= slow_top and latest["high"] >= slow_bottom
    latest_day_candles = [candle for candle in candles if candle.get("session_date") == latest.get("session_date")]
    day_high = max(candle["high"] for candle in latest_day_candles or candles)
    stop_loss = slow_bottom - config.stop_loss_offset

    return {
        "symbol": symbol,
        "signal": fast_cloud_above_slow_cloud and touched_slow_cloud,
        "side": "BUY",
        "quantity": config.entry_quantity,
        "last_price": snapshot_price(snapshot) or latest["close"],
        "last_price_source": "snapshot" if snapshot_price(snapshot) is not None else "latest_10m_candle_close",
        "last_quote_time": snapshot_time(snapshot),
        "latest_10m_close": latest["close"],
        "latest_bar_time": latest.get("time"),
        "latest_low": latest["low"],
        "latest_high": latest["high"],
        "day_high_target": round(day_high, 2),
        "stop_loss": round(stop_loss, 2),
        "ema": {
            "ema5": round(ema5[-1], 4),
            "ema12": round(ema12[-1], 4),
            "ema34": round(ema34[-1], 4),
            "ema50": round(ema50[-1], 4),
        },
        "checks": {
            "fast_cloud_above_slow_cloud": fast_cloud_above_slow_cloud,
            "price_touched_34_50_cloud": touched_slow_cloud,
        },
        "reason": "Entry criteria matched." if fast_cloud_above_slow_cloud and touched_slow_cloud else "No entry: criteria not fully matched.",
    }


def load_snapshots(service: WebullService, symbols: list[str]) -> dict[str, dict[str, Any]]:
    snapshots: dict[str, dict[str, Any]] = {}
    for index in range(0, len(symbols), 50):
        chunk = symbols[index:index + 50]
        response = service.market_snapshot(chunk, Category.US_STOCK.name)
        if not response.get("ok"):
            continue
        for item in find_snapshot_list(response.get("data")):
            symbol = str(item.get("symbol") or item.get("ticker") or item.get("code") or "").upper()
            if symbol:
                snapshots[symbol] = item
    return snapshots


def find_snapshot_list(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)]
    if isinstance(data, dict):
        if data.get("symbol") or data.get("ticker") or data.get("code"):
            return [data]
        for key in ("data", "items", "list", "snapshots"):
            if isinstance(data.get(key), list):
                return [item for item in data[key] if isinstance(item, dict)]
        for value in data.values():
            found = find_snapshot_list(value)
            if found:
                return found
    return []


def snapshot_price(snapshot: dict[str, Any] | None) -> float | None:
    if not snapshot:
        return None
    return pick_number(
        snapshot,
        "last_price",
        "lastPrice",
        "price",
        "close",
        "pPrice",
        "trade_price",
        "tradePrice",
    )


def snapshot_time(snapshot: dict[str, Any] | None) -> Any:
    if not snapshot:
        return None
    raw_time = (
        snapshot.get("trade_time")
        or snapshot.get("tradeTime")
        or snapshot.get("last_trade_time")
        or snapshot.get("lastTradeTime")
        or snapshot.get("time")
    )
    return parse_time(raw_time) or raw_time


def ema(values: list[float], period: int) -> list[float]:
    multiplier = 2 / (period + 1)
    output = [sum(values[:period]) / period]
    for value in values[period:]:
        output.append((value - output[-1]) * multiplier + output[-1])
    padding = [output[0]] * (period - 1)
    return padding + output


def aggregate_to_10_minute(candles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    aggregated = []
    for index in range(0, len(candles) - 1, 2):
        first = candles[index]
        second = candles[index + 1]
        aggregated.append(
            {
                "time": second.get("time") or first.get("time"),
                "sort_time": second.get("sort_time") or first.get("sort_time"),
                "session_date": second.get("session_date") or first.get("session_date"),
                "open": first["open"],
                "high": max(first["high"], second["high"]),
                "low": min(first["low"], second["low"]),
                "close": second["close"],
                "volume": first.get("volume", 0) + second.get("volume", 0),
            }
        )
    return aggregated


def normalize_bars(data: Any) -> list[dict[str, Any]]:
    raw_bars = find_bar_list(data)
    normalized = []
    for bar in raw_bars:
        parsed = parse_bar(bar)
        if parsed:
            normalized.append(parsed)
    return sorted(normalized, key=lambda candle: candle.get("sort_time") or "")


def find_bar_list(data: Any) -> list[Any]:
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("bars", "data", "items", "list"):
            if isinstance(data.get(key), list):
                return data[key]
        for value in data.values():
            found = find_bar_list(value)
            if found:
                return found
    return []


def parse_bar(bar: Any) -> dict[str, Any] | None:
    if isinstance(bar, dict):
        open_price = pick_number(bar, "open", "o")
        high = pick_number(bar, "high", "h")
        low = pick_number(bar, "low", "l")
        close = pick_number(bar, "close", "c")
        volume = pick_number(bar, "volume", "v") or 0
        if None in (open_price, high, low, close):
            return None
        return {
            "time": bar.get("time") or bar.get("timestamp") or bar.get("t"),
            "sort_time": parse_time(bar.get("time") or bar.get("timestamp") or bar.get("t")),
            "session_date": session_date(bar.get("time") or bar.get("timestamp") or bar.get("t")),
            "open": open_price,
            "high": high,
            "low": low,
            "close": close,
            "volume": volume,
        }
    if isinstance(bar, list) and len(bar) >= 5:
        values = [to_float(value) for value in bar[1:6]]
        if None in values[:4]:
            return None
        return {
            "time": bar[0],
            "sort_time": parse_time(bar[0]),
            "session_date": session_date(bar[0]),
            "open": values[0],
            "high": values[1],
            "low": values[2],
            "close": values[3],
            "volume": values[4] or 0,
        }
    return None


def pick_number(mapping: dict[str, Any], *keys: str) -> float | None:
    for key in keys:
        if key in mapping:
            return to_float(mapping[key])
    return None


def to_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_time(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    try:
        if text.isdigit():
            timestamp = int(text)
            if timestamp > 10_000_000_000:
                timestamp = timestamp / 1000
            return datetime.fromtimestamp(timestamp, MARKET_TIMEZONE).isoformat()
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=MARKET_TIMEZONE)
        return parsed.astimezone(MARKET_TIMEZONE).isoformat()
    except (ValueError, OSError):
        return text


def session_date(value: Any) -> str | None:
    parsed = parse_time(value)
    return parsed[:10] if parsed else None
