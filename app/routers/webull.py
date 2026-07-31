import json
import time
import ssl
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from webull.data.common.category import Category
from webull.data.common.timespan import Timespan

from app.config import get_settings
from app.dependencies import service
from app.market_data import (
    INTRADAY_EMA_SESSIONS,
    LIVE_WATCHLIST,
    batch_bar_map,
    batch_history_bars_chunked,
    build_live_prices,
    chart_ema,
    parse_symbols,
)
from app.strategy import normalize_bars
from app.watchlists import WatchlistStore
from app.webull_service import WebullConfigurationError


router = APIRouter(prefix="/api/webull")
LIVE_PRICE_CACHE_TTL_SECONDS = 60
_live_price_cache: dict[tuple[str, float, str, float], tuple[float, dict[str, Any]]] = {}


class WatchlistsPayload(BaseModel):
    watchlists: list[dict[str, Any]]


@router.get("/quote")
def webull_quote(symbol: str = Query(default="AAPL", min_length=1, max_length=16)):
    try:
        return service().live_quote(symbol=symbol, category=Category.US_STOCK.name)
    except WebullConfigurationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/live-prices")
def webull_live_prices(
    symbols: str = Query(default=",".join(LIVE_WATCHLIST)),
    risk_amount: float = Query(default=100, ge=1, le=10000),
    stop_mode: str = Query(default="fixed", pattern="^(fixed|auto)$"),
    fixed_stop_buffer: float = Query(default=1, ge=0.05, le=25),
    force: bool = Query(default=False),
):
    try:
        cache_key = (symbols.upper(), risk_amount, stop_mode, fixed_stop_buffer)
        if not force:
            cached_at, cached_payload = _live_price_cache.get(cache_key, (0, {}))
            if cached_payload and time.time() - cached_at < LIVE_PRICE_CACHE_TTL_SECONDS:
                return {**cached_payload, "cache": "hit"}
        payload = build_live_prices(
            service(),
            symbols,
            risk_amount=risk_amount,
            stop_mode=stop_mode,
            fixed_stop_buffer=fixed_stop_buffer,
        )
        if payload.get("ok"):
            _live_price_cache[cache_key] = (time.time(), payload)
        return payload
    except WebullConfigurationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/chart-bars")
def webull_chart_bars(
    symbols: str = Query(default=",".join(LIVE_WATCHLIST)),
    timeframe: str = Query(default="5", pattern="^(5|60|D)$"),
    count: int = Query(default=240, ge=60, le=1200),
):
    try:
        selected_symbols = parse_symbols(symbols)
        timespan = {
            "5": Timespan.M5.name,
            "60": Timespan.M60.name,
            "D": Timespan.D.name,
        }[timeframe]
        response = batch_history_bars_chunked(
            service(),
            selected_symbols,
            Category.US_STOCK.name,
            timespan,
            count=str(count),
            real_time_required=None if timeframe in ("60", "D") else True,
            trading_sessions=INTRADAY_EMA_SESSIONS if timeframe in ("5", "60") else None,
        )
        bar_map = batch_bar_map(response.get("data"))
        missing_symbols = [
            symbol for symbol in selected_symbols
            if not normalize_bars(bar_map.get(symbol))
        ]
        fallback_candles = {}
        if missing_symbols:
            with ThreadPoolExecutor(max_workers=min(8, len(missing_symbols))) as executor:
                fallback_candles = dict(
                    zip(
                        missing_symbols,
                        executor.map(lambda item: fallback_chart_candles(item, timeframe, count), missing_symbols),
                    )
                )
        charts = {}
        for symbol in selected_symbols:
            candles = normalize_bars(bar_map.get(symbol))[-count:]
            if not candles:
                candles = fallback_candles.get(symbol, [])
            charts[symbol] = {"symbol": symbol, "bars": candles_with_emas(candles[-count:])}
        has_bars = any(chart["bars"] for chart in charts.values())
        return {
            "ok": bool(response.get("ok") or has_bars),
            "source": "webull" if response.get("ok") else "yahoo-fallback",
            "timeframe": timeframe,
            "symbols": selected_symbols,
            "charts": charts,
            "errors": [] if response.get("ok") else response.get("chunks", []),
        }
    except WebullConfigurationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def candles_with_emas(candles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    closes = [candle["close"] for candle in candles if candle.get("close") is not None]
    ema_series = {period: chart_ema(closes, int(period)) for period in ("5", "12", "34", "50")}
    bars = []
    for index, candle in enumerate(candles):
        bars.append(
            {
                "time": candle.get("time") or candle.get("sort_time"),
                "open": round(candle["open"], 4),
                "high": round(candle["high"], 4),
                "low": round(candle["low"], 4),
                "close": round(candle["close"], 4),
                "volume": round(candle.get("volume", 0), 4),
                "ema5": round(ema_series["5"][index], 4) if index < len(ema_series["5"]) else None,
                "ema12": round(ema_series["12"][index], 4) if index < len(ema_series["12"]) else None,
                "ema34": round(ema_series["34"][index], 4) if index < len(ema_series["34"]) else None,
                "ema50": round(ema_series["50"][index], 4) if index < len(ema_series["50"]) else None,
            }
        )
    return bars


def fallback_chart_candles(symbol: str, timeframe: str, count: int) -> list[dict[str, Any]]:
    return eod_chart_candles(symbol, timeframe, count) or yahoo_chart_candles(symbol, timeframe, count)


def yahoo_chart_candles(symbol: str, timeframe: str, count: int) -> list[dict[str, Any]]:
    interval = {"5": "5m", "60": "60m", "D": "1d"}[timeframe]
    range_value = {"5": "5d", "60": "1mo", "D": "1y"}[timeframe]
    query = urllib.parse.urlencode({
        "interval": interval,
        "range": range_value,
        "includePrePost": "true" if timeframe in ("5", "60") else "false",
    })
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(symbol)}?{query}"
    try:
        with urllib.request.urlopen(url, timeout=3, context=ssl_context()) as response:
            payload = response.read()
        data = json.loads(payload)
    except Exception:
        return []
    result = ((data.get("chart") or {}).get("result") or [{}])[0]
    timestamps = result.get("timestamp") or []
    quote = (((result.get("indicators") or {}).get("quote") or [{}])[0])
    candles = []
    for index, timestamp in enumerate(timestamps):
        open_price = value_at(quote.get("open"), index)
        high = value_at(quote.get("high"), index)
        low = value_at(quote.get("low"), index)
        close = value_at(quote.get("close"), index)
        if None in (open_price, high, low, close):
            continue
        candles.append(
            {
                "time": datetime.fromtimestamp(timestamp, timezone.utc).isoformat(),
                "sort_time": datetime.fromtimestamp(timestamp, timezone.utc).isoformat(),
                "open": open_price,
                "high": high,
                "low": low,
                "close": close,
                "volume": value_at(quote.get("volume"), index) or 0,
            }
        )
    return candles[-count:]


def eod_chart_candles(symbol: str, timeframe: str, count: int) -> list[dict[str, Any]]:
    interval = {"5": "5m", "60": "1h", "D": "1d"}[timeframe]
    seconds_back = {"5": 7 * 24 * 60 * 60, "60": 60 * 24 * 60 * 60, "D": 365 * 24 * 60 * 60}[timeframe]
    now = int(time.time())
    query = urllib.parse.urlencode({
        "api_token": "demo",
        "interval": interval,
        "fmt": "json",
        "from": str(now - seconds_back),
        "to": str(now),
    })
    url = f"https://eodhd.com/api/intraday/{urllib.parse.quote(symbol)}.US?{query}"
    try:
        with urllib.request.urlopen(url, timeout=3, context=ssl_context()) as response:
            data = json.loads(response.read())
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    candles = []
    for item in data:
        if not isinstance(item, dict):
            continue
        open_price = value_from(item, "open")
        high = value_from(item, "high")
        low = value_from(item, "low")
        close = value_from(item, "close")
        if None in (open_price, high, low, close):
            continue
        candles.append(
            {
                "time": item.get("datetime") or item.get("timestamp"),
                "sort_time": item.get("datetime") or item.get("timestamp"),
                "open": open_price,
                "high": high,
                "low": low,
                "close": close,
                "volume": value_from(item, "volume") or 0,
            }
        )
    return candles[-count:]


def value_at(values: Any, index: int) -> float | None:
    if not isinstance(values, list) or index >= len(values):
        return None
    try:
        return float(values[index]) if values[index] is not None else None
    except (TypeError, ValueError):
        return None


def value_from(mapping: dict[str, Any], key: str) -> float | None:
    try:
        return float(mapping[key]) if mapping.get(key) is not None else None
    except (TypeError, ValueError):
        return None


def ssl_context() -> ssl.SSLContext:
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl._create_unverified_context()


@router.get("/watchlists")
def get_watchlists():
    settings = get_settings()
    return {"watchlists": WatchlistStore(settings.watchlist_file).all()}


@router.post("/watchlists")
def save_watchlists(payload: WatchlistsPayload):
    settings = get_settings()
    return {"watchlists": WatchlistStore(settings.watchlist_file).replace(payload.watchlists)}
