from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException
from webull.data.common.category import Category
from webull.data.common.timespan import Timespan

from app.strategy import find_snapshot_list, normalize_bars, snapshot_price
from app.webull_service import WebullService


LIVE_WATCHLIST = [
    "BE", "CRDO", "AAOI", "SNDK", "MU", "GLW", "MRVL", "COHR", "RKLB",
    "ASTS", "AMD", "ARM", "AVGO", "DELL", "INTC", "APP", "LLY",
    "APLD", "CIFR", "CRWV", "HUT", "IREN", "NBIS", "WULF",
]
INTRADAY_EMA_SESSIONS = ["PRE", "RTH", "ATH"]

SYMBOL_SECTORS = {
    "BE": "Clean Energy",
    "CRDO": "Semiconductors",
    "AAOI": "Optical Networking",
    "SNDK": "Storage",
    "MU": "Memory",
    "GLW": "Components",
    "MRVL": "Semiconductors",
    "COHR": "Optical Networking",
    "RKLB": "Space",
    "ASTS": "Space",
    "AMD": "Semiconductors",
    "ARM": "Semiconductors",
    "AVGO": "Semiconductors",
    "DELL": "Hardware",
    "INTC": "Semiconductors",
    "APP": "Software",
    "LLY": "Healthcare",
    "APLD": "Data Centers",
    "CIFR": "Crypto Mining",
    "CRWV": "Cloud AI",
    "HUT": "Crypto Mining",
    "IREN": "Data Centers",
    "NBIS": "Cloud AI",
    "WULF": "Crypto Mining",
}


def build_live_prices(webull: WebullService, symbols: str) -> dict[str, Any]:
    selected_symbols = parse_symbols(symbols)
    snapshot_response = webull.market_snapshot(selected_symbols, Category.US_STOCK.name)
    m5_response = webull.batch_history_bars(
        selected_symbols,
        Category.US_STOCK.name,
        Timespan.M5.name,
        count="1200",
        trading_sessions=INTRADAY_EMA_SESSIONS,
    )
    h1_response = webull.batch_history_bars(
        selected_symbols,
        Category.US_STOCK.name,
        Timespan.M60.name,
        count="1200",
        real_time_required=None,
        trading_sessions=INTRADAY_EMA_SESSIONS,
    )
    daily_response = webull.batch_history_bars(
        selected_symbols,
        Category.US_STOCK.name,
        Timespan.D.name,
        count="1200",
        real_time_required=None,
    )

    snapshot_map = {
        str(item.get("symbol") or item.get("ticker") or item.get("code") or "").upper(): item
        for item in find_snapshot_list(snapshot_response.get("data"))
    }
    m5_map = batch_bar_map(m5_response.get("data"))
    h1_map = batch_bar_map(h1_response.get("data"))
    daily_map = batch_bar_map(daily_response.get("data"))

    quotes = []
    for symbol in selected_symbols:
        ten_minute_candles = aggregate_by_minutes(normalize_bars(m5_map.get(symbol)), 10)
        h1_candles = normalize_bars(h1_map.get(symbol))
        daily_candles = normalize_bars(daily_map.get(symbol))
        price = snapshot_price(snapshot_map.get(symbol))
        ema_1h = ema_values(h1_candles, [20, 21, 34, 50, 55])
        ema_daily = ema_values(daily_candles, [20, 21, 50, 55])
        ten_minute_ema = ema_values(ten_minute_candles, [5, 12, 34, 50])
        ten_minute_trend = cloud_status(ten_minute_ema, ["5", "12"], ["34", "50"])
        quotes.append(
            {
                "symbol": symbol,
                "sector": SYMBOL_SECTORS.get(symbol, "Other"),
                "price": price,
                "change": snapshot_change(snapshot_map.get(symbol)),
                "change_ratio": snapshot_change_ratio(snapshot_map.get(symbol)),
                "ema_10m": ten_minute_ema,
                "ema_1h": ema_1h,
                "ema_daily": ema_daily,
                "mtf_matches": mtf_signal_matches(price, ten_minute_trend, ten_minute_candles, ten_minute_ema, ema_1h, ema_daily),
            }
        )

    errors = []
    for label, response in (
        ("snapshot", snapshot_response),
        ("5m bars", m5_response),
        ("1h bars", h1_response),
        ("daily bars", daily_response),
    ):
        if not response.get("ok"):
            errors.append({"source": label, "error": response})

    return {
        "ok": not errors,
        "source": "webull",
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "symbols": selected_symbols,
        "quotes": quotes,
        "errors": errors,
    }


def parse_symbols(symbols: str) -> list[str]:
    selected_symbols = [symbol.strip().upper() for symbol in symbols.split(",") if symbol.strip()]
    if not selected_symbols:
        raise HTTPException(status_code=400, detail="At least one symbol is required.")
    if len(selected_symbols) > 25:
        raise HTTPException(status_code=400, detail="Use 25 symbols or fewer.")
    return selected_symbols


def batch_bar_map(data: Any) -> dict[str, list[Any]]:
    if not isinstance(data, dict) or not isinstance(data.get("result"), list):
        return {}
    output = {}
    for item in data["result"]:
        if not isinstance(item, dict):
            continue
        symbol = str(item.get("symbol") or "").upper()
        bars = item.get("result")
        if symbol and isinstance(bars, list):
            output[symbol] = bars
    return output


def ema_values(candles: list[dict[str, Any]], periods: list[int]) -> dict[str, float | None]:
    closes = [candle["close"] for candle in candles if candle.get("close") is not None]
    values = {}
    for period in periods:
        values[str(period)] = round(chart_ema(closes, period)[-1], 4) if len(closes) >= period else None
    return values


def chart_ema(values: list[float], period: int) -> list[float]:
    if not values:
        return []
    multiplier = 2 / (period + 1)
    output = [values[0]]
    for value in values[1:]:
        output.append((value - output[-1]) * multiplier + output[-1])
    return output


def snapshot_change(snapshot: dict[str, Any] | None) -> float | None:
    return snapshot_number(snapshot, "change")


def snapshot_change_ratio(snapshot: dict[str, Any] | None) -> float | None:
    return snapshot_number(snapshot, "change_ratio", "changeRatio")


def snapshot_number(snapshot: dict[str, Any] | None, *keys: str) -> float | None:
    if not snapshot:
        return None
    for key in keys:
        value = snapshot.get(key)
        if value in (None, ""):
            continue
        try:
            return float(str(value).replace(",", ""))
        except ValueError:
            continue
    return None


def mtf_matches(price: float | None, ema_1h: dict[str, float | None], ema_daily: dict[str, float | None]) -> list[dict[str, Any]]:
    checks = [
        ("Hourly 34/50", ema_1h.get("34"), ema_1h.get("50")),
        ("Daily 20/21", ema_daily.get("20"), ema_daily.get("21")),
        ("Daily 50/55", ema_daily.get("50"), ema_daily.get("55")),
    ]
    matches = []
    for label, first, second in checks:
        if price is None or first is None or second is None:
            continue
        low = min(first, second)
        high = max(first, second)
        if low <= price <= high:
            matches.append({"label": label, "low": round(low, 4), "high": round(high, 4)})
    return matches


def mtf_signal_matches(
    price: float | None,
    ten_minute_trend: str,
    ten_minute_candles: list[dict[str, Any]],
    ema_10m: dict[str, float | None],
    ema_1h: dict[str, float | None],
    ema_daily: dict[str, float | None],
) -> list[dict[str, Any]]:
    if ten_minute_trend == "Chop":
        return []
    return [
        *mtf_matches(price, ema_1h, ema_daily),
        *ema_cloud_bounce_matches(ten_minute_candles, ema_10m, ema_1h, ema_daily),
    ]


def ema_cloud_bounce_matches(
    ten_minute_candles: list[dict[str, Any]],
    ema_10m: dict[str, float | None],
    ema_1h: dict[str, float | None],
    ema_daily: dict[str, float | None],
) -> list[dict[str, Any]]:
    candle = latest_complete_candle(ten_minute_candles)
    if not candle:
        return []

    close = candle.get("close")
    low = candle.get("low")
    if close is None or low is None:
        return []

    checks = [
        ("10m bounce 34/50", ema_10m.get("34"), ema_10m.get("50"), "10m", cloud_status(ema_10m, ["5", "12"], ["34", "50"])),
        ("10m bounce Hourly 34/50", ema_1h.get("34"), ema_1h.get("50"), "hourly"),
        ("10m bounce Daily 20/21", ema_daily.get("20"), ema_daily.get("21"), "daily"),
        ("10m bounce Daily 50/55", ema_daily.get("50"), ema_daily.get("55"), "daily"),
    ]
    matches = []
    for check in checks:
        label, first, second, timeframe, *trend = check
        if first is None or second is None:
            continue
        cloud_low = min(first, second)
        cloud_high = max(first, second)
        if low <= cloud_high and close > cloud_high:
            matches.append(
                {
                    "label": label,
                    "timeframe": timeframe,
                    "cloud_low": round(cloud_low, 4),
                    "cloud_high": round(cloud_high, 4),
                    "candle_low": round(low, 4),
                    "candle_close": round(close, 4),
                    "type": "10m_cloud_bounce",
                    **({"trend": trend[0]} if trend and trend[0] != "-" else {}),
                }
            )
    return matches


def cloud_status(ema_set: dict[str, float | None], fast_keys: list[str], slow_keys: list[str]) -> str:
    values = [ema_set.get(key) for key in [*fast_keys, *slow_keys]]
    if any(value is None for value in values):
        return "-"

    fast_values = [ema_set[key] for key in fast_keys]
    slow_values = [ema_set[key] for key in slow_keys]
    fast_bottom = min(fast_values)
    fast_top = max(fast_values)
    slow_bottom = min(slow_values)
    slow_top = max(slow_values)

    if fast_bottom > slow_top:
        return "Bullish"
    if fast_top < slow_bottom:
        return "Bearish"
    return "Chop"


def latest_complete_candle(candles: list[dict[str, Any]]) -> dict[str, Any] | None:
    for candle in reversed(candles):
        source_count = candle.get("source_count")
        if source_count is None or source_count >= 2:
            return candle
    return None


def aggregate_by_minutes(candles: list[dict[str, Any]], minutes: int) -> list[dict[str, Any]]:
    buckets: dict[datetime, dict[str, Any]] = {}
    for candle in candles:
        parsed_time = parse_iso_time(candle.get("sort_time") or candle.get("time"))
        if not parsed_time:
            continue
        bucket_time = parsed_time.replace(
            minute=(parsed_time.minute // minutes) * minutes,
            second=0,
            microsecond=0,
        )
        bucket = buckets.get(bucket_time)
        if not bucket:
            buckets[bucket_time] = {
                "time": bucket_time.isoformat(),
                "sort_time": bucket_time.isoformat(),
                "session_date": bucket_time.date().isoformat(),
                "open": candle["open"],
                "high": candle["high"],
                "low": candle["low"],
                "close": candle["close"],
                "volume": candle.get("volume", 0),
                "source_count": 1,
            }
            continue
        bucket["high"] = max(bucket["high"], candle["high"])
        bucket["low"] = min(bucket["low"], candle["low"])
        bucket["close"] = candle["close"]
        bucket["volume"] += candle.get("volume", 0)
        bucket["source_count"] += 1
    return [buckets[key] for key in sorted(buckets)]


def parse_iso_time(value: Any) -> datetime | None:
    if not value:
        return None
    text = str(value).replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None
