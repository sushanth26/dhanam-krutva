from datetime import datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

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
WEBULL_BATCH_BAR_LIMIT = 20
MARKET_TIMEZONE = ZoneInfo("America/New_York")
REGULAR_MARKET_OPEN = time(9, 30)
NINE_EMA_TOUCH_CUTOFF = time(10, 30)
NINE_EMA_RECENT_CLOUD_LOOKBACK = 4
CURL_MTF_TOUCH_LOOKBACK = timedelta(hours=1)
BOUNCE_OVERHEAD_CLOUD_BUFFER = 0.015
A_PLUS_PLUS_MAX_RISK = 100
A_PLUS_PLUS_STOP_BUFFER = 1
MTF_CLOUD_STOP_BUFFER = 3
A_PLUS_PLUS_STOP_MODE_FIXED = "fixed"
A_PLUS_PLUS_STOP_MODE_AUTO = "auto"
LONG_MTF_CLOUDS = [
    {"label": "Hourly 34/50", "timeframe": "1h", "source": "hourly", "keys": ("34", "50")},
    {"label": "Daily 20/21", "timeframe": "daily", "source": "daily", "keys": ("20", "21")},
    {"label": "Daily 50/55", "timeframe": "daily", "source": "daily", "keys": ("50", "55")},
]

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


def build_live_prices(
    webull: WebullService,
    symbols: str,
    risk_amount: float = A_PLUS_PLUS_MAX_RISK,
    stop_mode: str = A_PLUS_PLUS_STOP_MODE_FIXED,
    fixed_stop_buffer: float = A_PLUS_PLUS_STOP_BUFFER,
) -> dict[str, Any]:
    selected_symbols = parse_symbols(symbols)
    snapshot_response = webull.market_snapshot(selected_symbols, Category.US_STOCK.name)
    m5_response = batch_history_bars_chunked(
        webull,
        selected_symbols,
        Category.US_STOCK.name,
        Timespan.M5.name,
        count="1200",
        trading_sessions=INTRADAY_EMA_SESSIONS,
    )
    h1_response = batch_history_bars_chunked(
        webull,
        selected_symbols,
        Category.US_STOCK.name,
        Timespan.M60.name,
        count="1200",
        real_time_required=None,
        trading_sessions=INTRADAY_EMA_SESSIONS,
    )
    daily_response = batch_history_bars_chunked(
        webull,
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
        ten_minute_ema = ema_values(ten_minute_candles, [5, 9, 12, 34, 50])
        ten_minute_trend = cloud_status(ten_minute_ema, ["5", "12"], ["34", "50"])
        candle_price = latest_ten_minute_price(ten_minute_candles, price)
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
                "mtf_matches": mtf_signal_matches(
                    candle_price,
                    ten_minute_trend,
                    ten_minute_candles,
                    ten_minute_ema,
                    ema_1h,
                    ema_daily,
                    daily_candles=daily_candles,
                    risk_amount=risk_amount,
                    stop_mode=stop_mode,
                    fixed_stop_buffer=fixed_stop_buffer,
                    live_price=price,
                ),
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


def batch_history_bars_chunked(
    webull: WebullService,
    symbols: list[str],
    category: str,
    timespan: str,
    count: str,
    real_time_required: bool | None = True,
    trading_sessions: list[str] | str | None = None,
) -> dict[str, Any]:
    responses = [
        webull.batch_history_bars(
            chunk,
            category,
            timespan,
            count=count,
            real_time_required=real_time_required,
            trading_sessions=trading_sessions,
        )
        for chunk in symbol_chunks(symbols, WEBULL_BATCH_BAR_LIMIT)
    ]
    merged_results = []
    for response in responses:
        data = response.get("data")
        if isinstance(data, dict) and isinstance(data.get("result"), list):
            merged_results.extend(data["result"])
    return {
        "ok": all(response.get("ok") for response in responses),
        "data": {"result": merged_results},
        "chunks": responses,
    }


def symbol_chunks(symbols: list[str], size: int) -> list[list[str]]:
    return [symbols[index:index + size] for index in range(0, len(symbols), size)]


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


def mtf_matches(
    price: float | None,
    trend: str,
    ema_10m: dict[str, float | None],
    ema_1h: dict[str, float | None],
    ema_daily: dict[str, float | None],
    previous_price: float | None = None,
    current_high: float | None = None,
    current_low: float | None = None,
    candle_complete: bool = True,
    risk_amount: float = A_PLUS_PLUS_MAX_RISK,
) -> list[dict[str, Any]]:
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
        match = {
            "label": label,
            "display_label": label,
            "low": round(low, 4),
            "high": round(high, 4),
            "entry_price": round(price, 4),
            "trend": trend,
            "type": "mtf_cloud_breakout",
        }
        if low <= price <= high:
            matches.append({**match, "type": "mtf_cloud_inside", "status": "waiting", "direction": "inside"})
            continue

        action_match = {**match, "trade_action": trade_action_for_trend(trend)}
        if trend in ("Bullish", "Bearish"):
            action_match.update(mtf_cloud_breakout_risk_fields(price, low, high, trend, risk_amount))
        if trend == "Bullish":
            if candle_complete and previous_price is not None and previous_price <= high and price > high:
                matches.append({**action_match, "status": "confirmed", "direction": "above"})
                continue
        elif trend == "Bearish":
            if candle_complete and previous_price is not None and previous_price >= low and price < low:
                matches.append({**action_match, "status": "confirmed", "direction": "below"})
                continue

        if candle_touches_cloud(current_low, current_high, low, high):
            matches.append({**match, "type": "mtf_cloud_touch", "status": "confirmed", "direction": "touch"})
    return matches


def mtf_signal_matches(
    price: float | None,
    ten_minute_trend: str,
    ten_minute_candles: list[dict[str, Any]],
    ema_10m: dict[str, float | None],
    ema_1h: dict[str, float | None],
    ema_daily: dict[str, float | None],
    daily_candles: list[dict[str, Any]] | None = None,
    risk_amount: float = A_PLUS_PLUS_MAX_RISK,
    stop_mode: str = A_PLUS_PLUS_STOP_MODE_FIXED,
    fixed_stop_buffer: float = A_PLUS_PLUS_STOP_BUFFER,
    live_price: float | None = None,
) -> list[dict[str, Any]]:
    candle = latest_ten_minute_candle(ten_minute_candles)
    candle_time = candle_time_key(candle) if candle else None
    return [
        *long_mtf_pullback_matches(
            ten_minute_trend,
            ten_minute_candles,
            ema_10m,
            ema_1h,
            ema_daily,
        ),
        *ten_minute_34_50_bounce_matches(ten_minute_candles, ema_1h, ema_daily),
        *mtf_cloud_touch_matches(live_price, ema_1h, ema_daily, candle_time),
    ]


def mtf_cloud_touch_matches(
    price: float | None,
    ema_1h: dict[str, float | None],
    ema_daily: dict[str, float | None],
    candle_time: Any = None,
) -> list[dict[str, Any]]:
    if price is None:
        return []

    matches = []
    for check in LONG_MTF_CLOUDS:
        ema_set = ema_1h if check["source"] == "hourly" else ema_daily
        first = ema_set.get(check["keys"][0])
        second = ema_set.get(check["keys"][1])
        if first is None or second is None:
            continue
        cloud_low = min(first, second)
        cloud_high = max(first, second)
        if not (cloud_low <= price <= cloud_high):
            continue
        matches.append(
            {
                "label": check["label"],
                "display_label": f"{check['label']} touch",
                "cloud_label": check["label"],
                "timeframe": check["timeframe"],
                "cloud_low": round(cloud_low, 4),
                "cloud_high": round(cloud_high, 4),
                "entry_price": round(price, 4),
                "last_price": round(price, 4),
                "candle_time": candle_time,
                "type": "mtf_cloud_price_touch",
                "status": "confirmed",
                "direction": "touch",
            }
        )
    return matches


def long_mtf_pullback_matches(
    ten_minute_trend: str,
    ten_minute_candles: list[dict[str, Any]],
    ema_10m: dict[str, float | None],
    ema_1h: dict[str, float | None],
    ema_daily: dict[str, float | None],
) -> list[dict[str, Any]]:
    if ten_minute_trend not in ("Bullish", "Bearish"):
        return []

    candle = latest_ten_minute_candle(ten_minute_candles)
    if not candle:
        return []
    previous_candle = previous_ten_minute_candle(ten_minute_candles)
    if not previous_candle:
        return []

    candle_low = candle.get("low")
    candle_high = candle.get("high")
    candle_close = candle.get("close")
    previous_close = previous_candle.get("close")
    ema5 = ema_10m.get("5")
    ema12 = ema_10m.get("12")
    if None in (candle_low, candle_high, candle_close, previous_close, ema5, ema12):
        return []

    fast_cloud_low = min(ema5, ema12)
    fast_cloud_high = max(ema5, ema12)
    if not candle_touches_cloud(candle_low, candle_high, fast_cloud_low, fast_cloud_high):
        return []
    if candle_close <= fast_cloud_high or previous_close > fast_cloud_high:
        return []
    if candle_close <= previous_close:
        return []

    candle_time = candle.get("time") or candle.get("sort_time") or candle.get("timestamp")
    current_session = candle.get("session_date") or session_date_from_candle(candle)
    previous_today = [
        item
        for item in ten_minute_candles[:-1]
        if (item.get("session_date") or session_date_from_candle(item)) == current_session
    ]
    if not previous_today:
        return []

    fast_clouds_by_time = historical_fast_clouds_by_candle_time(ten_minute_candles)
    mtf_sources = []
    for check in LONG_MTF_CLOUDS:
        ema_set = ema_1h if check["source"] == "hourly" else ema_daily
        first = ema_set.get(check["keys"][0])
        second = ema_set.get(check["keys"][1])
        if first is None or second is None:
            continue
        cloud_low = min(first, second)
        cloud_high = max(first, second)
        if cloud_high >= fast_cloud_low:
            continue
        touch_candle = latest_valid_mtf_touch_before_10m_reclaim(
            previous_today,
            cloud_low,
            cloud_high,
            fast_clouds_by_time,
            candle_time,
        )
        if not touch_candle:
            continue
        touch_time = touch_candle.get("time") or touch_candle.get("sort_time") or touch_candle.get("timestamp")
        mtf_sources.append(
            {
                "label": check["label"],
                "timeframe": check["timeframe"],
                "touch_time": touch_time,
                "cloud_low": round(cloud_low, 4),
                "cloud_high": round(cloud_high, 4),
            }
        )
    if not mtf_sources:
        return []

    entry_price = max(fast_cloud_low, min(candle_close, fast_cloud_high))
    labels = [source["label"] for source in mtf_sources]
    return [
        {
            "label": "Curl",
            "display_label": f"Curl: {' + '.join(labels)} -> above 10m 5/12",
            "timeframe": "10m",
            "mtf_label": " + ".join(labels),
            "mtf_labels": labels,
            "mtf_touches": mtf_sources,
            "mtf_timeframe": "multi" if len(mtf_sources) > 1 else mtf_sources[0]["timeframe"],
            "mtf_touch_time": mtf_sources[0]["touch_time"],
            "mtf_cloud_low": mtf_sources[0]["cloud_low"],
            "mtf_cloud_high": mtf_sources[0]["cloud_high"],
            "cloud_low": round(fast_cloud_low, 4),
            "cloud_high": round(fast_cloud_high, 4),
            "candle_low": round(candle_low, 4),
            "candle_high": round(candle_high, 4),
            "candle_close": round(candle_close, 4),
            "entry_price": round(entry_price, 4),
            "candle_time": candle_time,
            "type": "long_mtf_5_12_touch",
            "status": "confirmed",
            "direction": "up_to_10m_5_12",
            "trend": ten_minute_trend,
            "trade_action": "Long",
        }
    ]


def latest_valid_mtf_touch_before_10m_reclaim(
    candles: list[dict[str, Any]],
    cloud_low: float,
    cloud_high: float,
    fast_clouds_by_time: dict[Any, tuple[float, float]],
    reclaim_time: Any = None,
) -> dict[str, Any] | None:
    for candle in reversed(candles):
        if not is_recent_curl_touch(candle_time_key(candle), reclaim_time):
            continue
        fast_cloud = fast_clouds_by_time.get(candle_time_key(candle))
        if not fast_cloud:
            continue
        if not candle_stays_below_cloud(candle, fast_cloud[0]):
            continue
        if candle_touches_cloud(candle.get("low"), candle.get("high"), cloud_low, cloud_high):
            return candle
    return None


def is_recent_curl_touch(touch_time: Any, reclaim_time: Any) -> bool:
    parsed_touch_time = parse_iso_time(touch_time)
    parsed_reclaim_time = parse_iso_time(reclaim_time)
    if not parsed_touch_time or not parsed_reclaim_time:
        return False
    return timedelta(0) <= parsed_reclaim_time - parsed_touch_time <= CURL_MTF_TOUCH_LOOKBACK


def ten_minute_34_50_bounce_matches(
    ten_minute_candles: list[dict[str, Any]],
    ema_1h: dict[str, float | None] | None = None,
    ema_daily: dict[str, float | None] | None = None,
) -> list[dict[str, Any]]:
    candle = latest_confirmed_ten_minute_candle(ten_minute_candles)
    if not candle:
        return []

    candle_low = candle.get("low")
    candle_high = candle.get("high")
    candle_close = candle.get("close")
    previous_candle = previous_confirmed_ten_minute_candle(ten_minute_candles, candle)
    previous_close = previous_candle.get("close") if previous_candle else None
    if None in (candle_low, candle_high, candle_close):
        return []
    if previous_close is not None and candle_close <= previous_close:
        return []

    ema_by_time = historical_ema_values_by_candle_time(ten_minute_candles, [34, 50])
    ema_values_at_candle = ema_by_time.get(candle_time_key(candle))
    if not ema_values_at_candle:
        return []
    ema34 = ema_values_at_candle.get("34")
    ema50 = ema_values_at_candle.get("50")
    if ema34 is None or ema50 is None:
        return []

    cloud_low = min(ema34, ema50)
    cloud_high = max(ema34, ema50)
    if not candle_touches_cloud(candle_low, candle_high, cloud_low, cloud_high):
        return []
    if candle_close <= cloud_high:
        return []

    candle_time = candle_time_key(candle)
    overhead_clouds = nearby_overhead_mtf_clouds(candle_close, ema_1h or {}, ema_daily or {})
    setup_quality = "ok" if overhead_clouds else "best"
    setup_quality_label = "OK" if setup_quality == "ok" else "Best"
    setup_quality_note = (
        f"Overhead cloud nearby: {', '.join(cloud['label'] for cloud in overhead_clouds)}"
        if overhead_clouds
        else "Clear room above 10m 34/50"
    )
    return [
        {
            "label": "10m 34/50 Bounce",
            "display_label": f"10m 34/50 Bounce ({setup_quality_label})",
            "timeframe": "10m",
            "mtf_label": "10m 34/50",
            "cloud_label": "10m 34/50",
            "setup_quality": setup_quality,
            "setup_quality_note": setup_quality_note,
            "overhead_clouds": overhead_clouds,
            "cloud_low": round(cloud_low, 4),
            "cloud_high": round(cloud_high, 4),
            "candle_low": round(candle_low, 4),
            "candle_high": round(candle_high, 4),
            "candle_close": round(candle_close, 4),
            "entry_price": round(candle_close, 4),
            "candle_time": candle_time,
            "type": "10m_34_50_bounce",
            "status": "confirmed",
            "direction": "bounce_above_10m_34_50",
            "trend": "Bullish",
            "trade_action": "Long",
        }
    ]


def nearby_overhead_mtf_clouds(
    entry_price: float,
    ema_1h: dict[str, float | None],
    ema_daily: dict[str, float | None],
) -> list[dict[str, Any]]:
    if entry_price <= 0:
        return []

    overhead_clouds = []
    for check in LONG_MTF_CLOUDS:
        ema_set = ema_1h if check["source"] == "hourly" else ema_daily
        first = ema_set.get(check["keys"][0])
        second = ema_set.get(check["keys"][1])
        if first is None or second is None:
            continue
        cloud_low = min(first, second)
        cloud_high = max(first, second)
        if cloud_high < entry_price:
            continue
        distance = max(cloud_low - entry_price, 0)
        distance_ratio = distance / entry_price
        if distance_ratio > BOUNCE_OVERHEAD_CLOUD_BUFFER:
            continue
        overhead_clouds.append(
            {
                "label": check["label"],
                "cloud_low": round(cloud_low, 4),
                "cloud_high": round(cloud_high, 4),
                "distance_pct": round(distance_ratio * 100, 2),
            }
        )
    return overhead_clouds


def historical_fast_clouds_by_candle_time(candles: list[dict[str, Any]]) -> dict[Any, tuple[float, float]]:
    ema5_values = aligned_ema_series(candles, 5)
    ema12_values = aligned_ema_series(candles, 12)
    clouds: dict[Any, tuple[float, float]] = {}
    for candle, ema5, ema12 in zip(candles, ema5_values, ema12_values):
        key = candle_time_key(candle)
        if key is None or ema5 is None or ema12 is None:
            continue
        clouds[key] = (min(ema5, ema12), max(ema5, ema12))
    return clouds


def historical_ema_values_by_candle_time(candles: list[dict[str, Any]], periods: list[int]) -> dict[Any, dict[str, float]]:
    series_by_period = {str(period): aligned_ema_series(candles, period) for period in periods}
    values_by_time: dict[Any, dict[str, float]] = {}
    for index, candle in enumerate(candles):
        key = candle_time_key(candle)
        if key is None:
            continue
        values = {
            period: series[index]
            for period, series in series_by_period.items()
            if series[index] is not None
        }
        if values:
            values_by_time[key] = values
    return values_by_time


def aligned_ema_series(candles: list[dict[str, Any]], period: int) -> list[float | None]:
    values: list[float | None] = []
    ema: float | None = None
    multiplier = 2 / (period + 1)
    for candle in candles:
        close = candle.get("close")
        if close is None:
            values.append(None)
            continue
        ema = close if ema is None else (close - ema) * multiplier + ema
        values.append(ema)
    return values


def candle_time_key(candle: dict[str, Any]) -> Any:
    return candle.get("time") or candle.get("sort_time") or candle.get("timestamp")


def candle_stays_below_cloud(candle: dict[str, Any], cloud_low: float) -> bool:
    high = candle.get("high")
    return high is not None and high < cloud_low


def session_date_from_candle(candle: dict[str, Any]) -> str | None:
    parsed_time = parse_iso_time(candle.get("sort_time") or candle.get("time") or candle.get("timestamp"))
    return parsed_time.date().isoformat() if parsed_time else None


def ema_touch_matches(
    price: float | None,
    candle_low: float | None,
    candle_high: float | None,
    ema_1h: dict[str, float | None],
    ema_daily: dict[str, float | None],
    candle_time: Any = None,
    ten_minute_trend: str | None = None,
) -> list[dict[str, Any]]:
    if candle_low is None or candle_high is None:
        return []

    checks = [
        ("Hourly", "1h", period, ema_1h.get(period))
        for period in ("34", "50")
    ] + [
        ("Daily", "daily", period, ema_daily.get(period))
        for period in ("20", "21", "50", "55")
    ]
    matches = []
    for label_prefix, timeframe, period, value in checks:
        if value is None or not (candle_low <= value <= candle_high):
            continue
        matches.append(
            {
                "label": f"{label_prefix} {period} EMA touch",
                "display_label": f"{label_prefix} {period} EMA touch",
                "timeframe": timeframe,
                "ema_period": period,
                "ema_value": round(value, 4),
                "candle_low": round(candle_low, 4),
                "candle_high": round(candle_high, 4),
                "entry_price": round(value, 4),
                "last_price": round(price, 4) if price is not None else None,
                "candle_time": candle_time,
                "type": "ema_touch",
                "status": "confirmed",
                "direction": "touch",
                "trend": ten_minute_trend,
            }
        )
    return matches


def mtf_signal_cloud_family(match: dict[str, Any]) -> str:
    label = str(match.get("label") or "")
    family_labels = {
        "Hourly 34/50": "hourly-34-50",
        "10m bounce Hourly 34/50": "hourly-34-50",
        "Daily 20/21": "daily-20-21",
        "10m bounce Daily 20/21": "daily-20-21",
        "Daily 50/55": "daily-50-55",
        "10m bounce Daily 50/55": "daily-50-55",
    }
    return family_labels.get(label, label)


def dedupe_mtf_signal_matches(matches: list[dict[str, Any]]) -> list[dict[str, Any]]:
    selected: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for match in matches:
        family = mtf_signal_cloud_family(match)
        current = selected.get(family)
        if current is None:
            selected[family] = match
            order.append(family)
            continue
        if match.get("type") == "10m_cloud_bounce" and current.get("type") != "10m_cloud_bounce":
            selected[family] = match
    return [selected[family] for family in order]


def candle_touches_cloud(
    candle_low: float | None,
    candle_high: float | None,
    cloud_low: float,
    cloud_high: float,
) -> bool:
    if candle_low is None or candle_high is None:
        return False
    return candle_low <= cloud_high and candle_high >= cloud_low


def display_label_for_setup(label: str, trade_action: str | None) -> str:
    if trade_action == "Short" and "bounce" in label:
        return label.replace("bounce", "rejection")
    return label


def latest_complete_candle_time(candles: list[dict[str, Any]]) -> Any:
    candle = latest_confirmed_ten_minute_candle(candles)
    if not candle:
        return None
    return candle.get("time") or candle.get("sort_time") or candle.get("timestamp")


def latest_ten_minute_price(candles: list[dict[str, Any]], fallback: float | None = None) -> float | None:
    candle = latest_ten_minute_candle(candles)
    return candle.get("close") if candle and candle.get("close") is not None else fallback


def ema_cloud_bounce_matches(
    ten_minute_candles: list[dict[str, Any]],
    ema_10m: dict[str, float | None],
    ema_1h: dict[str, float | None],
    ema_daily: dict[str, float | None],
    daily_candles: list[dict[str, Any]] | None = None,
    previous_price: float | None = None,
    risk_amount: float = A_PLUS_PLUS_MAX_RISK,
    stop_mode: str = A_PLUS_PLUS_STOP_MODE_FIXED,
    fixed_stop_buffer: float = A_PLUS_PLUS_STOP_BUFFER,
) -> list[dict[str, Any]]:
    candle = latest_ten_minute_candle(ten_minute_candles)
    if not candle:
        return []
    candle_complete = is_complete_ten_minute_candle(candle)

    close = candle.get("close")
    low = candle.get("low")
    high = candle.get("high")
    if close is None or low is None:
        return []
    high = high if high is not None else max(value for value in (candle.get("open"), close, low) if value is not None)
    candle_time = candle.get("time") or candle.get("sort_time") or candle.get("timestamp")
    ten_minute_trend = cloud_status(ema_10m, ["5", "12"], ["34", "50"])

    checks = [
        ("10m bounce 34/50", ema_10m.get("34"), ema_10m.get("50"), "10m", ten_minute_trend),
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
        trend_value = trend[0] if trend else ten_minute_trend
        trade_action = trade_action_for_trend(trend_value)
        display_label = display_label_for_setup(label, trade_action)
        touched_cloud = low <= cloud_high and high >= cloud_low
        if trend_value == "Bullish":
            confirmed_bounce = close > cloud_high
        elif trend_value == "Bearish":
            confirmed_bounce = candle_complete and close < cloud_low
        else:
            confirmed_bounce = False
        if timeframe == "10m":
            if trend_value == "Bullish":
                should_enter = candle_complete and touched_cloud and confirmed_bounce and (previous_price is None or previous_price <= cloud_high)
            else:
                should_enter = touched_cloud and confirmed_bounce
            if not should_enter:
                continue
            if trend_value == "Bullish":
                risk_fields = bullish_ten_minute_cloud_risk_fields(close, ema_10m, risk_amount)
                risk_plan = risk_fields.get("risk_plan")
            else:
                risk_fields = {}
                risk_plan = a_plus_plus_risk_plan(
                    entry=close,
                    cloud_low=cloud_low,
                    cloud_high=cloud_high,
                    trend=trend_value,
                    daily_candles=daily_candles,
                    risk_amount=risk_amount,
                    stop_mode=stop_mode,
                    fixed_stop_buffer=fixed_stop_buffer,
                )
            matches.append(
                {
                    "label": label,
                    "display_label": display_label,
                    "timeframe": timeframe,
                    "cloud_low": round(cloud_low, 4),
                    "cloud_high": round(cloud_high, 4),
                    "candle_low": round(low, 4),
                    "candle_high": round(high, 4),
                    "candle_close": round(close, 4),
                    "entry_price": round(close, 4),
                    "candle_time": candle_time,
                    "type": "10m_cloud_bounce",
                    "status": "confirmed",
                    "trend": trend_value,
                    "trade_action": trade_action,
                    **risk_fields,
                    **({"risk_plan": risk_plan} if risk_plan else {}),
                }
            )
            continue
        if candle_complete and touched_cloud and confirmed_bounce:
            risk_fields = bullish_ten_minute_cloud_risk_fields(close, ema_10m, risk_amount) if trend_value == "Bullish" else {}
            matches.append(
                {
                    "label": label,
                    "display_label": display_label,
                    "timeframe": timeframe,
                    "cloud_low": round(cloud_low, 4),
                    "cloud_high": round(cloud_high, 4),
                    "candle_low": round(low, 4),
                    "candle_high": round(high, 4),
                    "candle_close": round(close, 4),
                    "entry_price": round(close, 4),
                    "candle_time": candle_time,
                    "type": "10m_cloud_bounce",
                    "trend": trend_value,
                    "trade_action": trade_action,
                    **risk_fields,
                }
            )
    return matches


def nine_ema_touch_matches(
    ten_minute_candles: list[dict[str, Any]],
    ema_10m: dict[str, float | None],
    risk_amount: float = A_PLUS_PLUS_MAX_RISK,
) -> list[dict[str, Any]]:
    candle = latest_ten_minute_candle(ten_minute_candles)
    if not candle:
        return []
    candle_time = candle.get("time") or candle.get("sort_time") or candle.get("timestamp")

    ema9 = ema_10m.get("9")
    ema5 = ema_10m.get("5")
    ema12 = ema_10m.get("12")
    ema34 = ema_10m.get("34")
    ema50 = ema_10m.get("50")
    if ema9 is None or ema5 is None or ema12 is None or ema34 is None or ema50 is None:
        return []

    ten_minute_trend = cloud_status(ema_10m, ["5", "12"], ["34", "50"])
    if ten_minute_trend != "Bullish":
        return []
    if not (
        is_first_hour_regular_market_time(candle_time)
        or recent_previous_candle_touched_or_below_cloud(ten_minute_candles, ema34, ema50)
    ):
        return []

    low = candle.get("low")
    high = candle.get("high")
    close = candle.get("close")
    if low is None or close is None:
        return []
    high = high if high is not None else max(value for value in (candle.get("open"), close, low) if value is not None)
    if not (low <= ema9 <= high):
        return []

    fast_cloud_low = min(ema5, ema12)
    slow_cloud_low = min(ema34, ema50)
    slow_cloud_high = max(ema34, ema50)
    stop_buffer = A_PLUS_PLUS_STOP_BUFFER
    stop = slow_cloud_low - stop_buffer
    risk_plan = fixed_stop_risk_plan(
        entry=ema9,
        stop=stop,
        max_risk=risk_amount,
        stop_buffer=stop_buffer,
        stop_mode="10m-34-50-cloud",
    )
    if not risk_plan:
        return []

    return [
        {
            "label": "10m 9 EMA touch",
            "display_label": "10m 9 EMA touch",
            "timeframe": "10m",
            "ema9": round(ema9, 4),
            "cloud_low": round(fast_cloud_low, 4),
            "cloud_high": round(max(ema5, ema12), 4),
            "stop_cloud_low": round(slow_cloud_low, 4),
            "stop_cloud_high": round(slow_cloud_high, 4),
            "candle_low": round(low, 4),
            "candle_high": round(high, 4),
            "candle_close": round(close, 4),
            "entry_price": round(ema9, 4),
            "candle_time": candle_time,
            "type": "10m_9ema_touch",
            "status": "confirmed",
            "trend": ten_minute_trend,
            "trade_action": "Long",
            "risk_plan": risk_plan,
        }
    ]


def is_first_hour_regular_market_time(value: Any) -> bool:
    parsed_time = parse_iso_time(value)
    if not parsed_time:
        return False
    if parsed_time.tzinfo is None:
        market_time = parsed_time.replace(tzinfo=MARKET_TIMEZONE)
    else:
        market_time = parsed_time.astimezone(MARKET_TIMEZONE)
    current_time = market_time.time()
    return REGULAR_MARKET_OPEN <= current_time < NINE_EMA_TOUCH_CUTOFF


def recent_previous_candle_touched_or_below_cloud(candles: list[dict[str, Any]], first: float, second: float) -> bool:
    cloud_low = min(first, second)
    cloud_high = max(first, second)
    for candle in candles[-(NINE_EMA_RECENT_CLOUD_LOOKBACK + 1):-1]:
        low = candle.get("low")
        high = candle.get("high")
        close = candle.get("close")
        if low is None:
            continue
        if low <= cloud_low:
            return True
        candle_high = high if high is not None else max(value for value in (candle.get("open"), close, low) if value is not None)
        if low <= cloud_high and candle_high >= cloud_low:
            return True
    return False


def trade_action_for_trend(trend: str | None) -> str | None:
    if trend == "Bullish":
        return "Long"
    if trend == "Bearish":
        return "Short"
    return None


def fixed_stop_risk_plan(
    entry: float,
    stop: float,
    max_risk: float,
    stop_buffer: float,
    stop_mode: str,
) -> dict[str, Any] | None:
    risk_per_share = abs(entry - stop)
    if risk_per_share <= 0:
        return None

    risk_amount = max(1, float(max_risk or A_PLUS_PLUS_MAX_RISK))
    shares = int(risk_amount // risk_per_share)
    return {
        "entry": round(entry, 4),
        "stop": round(stop, 4),
        "stop_buffer": round(stop_buffer, 4),
        "stop_mode": stop_mode,
        "risk_per_share": round(risk_per_share, 4),
        "max_risk": round(risk_amount, 2),
        "shares": shares,
        "volatility": {"grade": "fixed", "average_range": None, "average_range_pct": None, "sample_size": 0},
    }


def mtf_cloud_breakout_risk_fields(
    entry: float | None,
    cloud_low: float,
    cloud_high: float,
    trend: str,
    risk_amount: float = A_PLUS_PLUS_MAX_RISK,
) -> dict[str, Any]:
    if entry is None:
        return {}
    stop_buffer = MTF_CLOUD_STOP_BUFFER
    if trend == "Bullish":
        stop = cloud_low - stop_buffer
    elif trend == "Bearish":
        stop = cloud_high + stop_buffer
    else:
        return {}
    risk_plan = fixed_stop_risk_plan(
        entry=entry,
        stop=stop,
        max_risk=risk_amount,
        stop_buffer=stop_buffer,
        stop_mode="mtf-cloud-3-dollar",
    )
    return {
        "stop_cloud_low": round(cloud_low, 4),
        "stop_cloud_high": round(cloud_high, 4),
        **({"risk_plan": risk_plan} if risk_plan else {}),
    }


def bullish_ten_minute_cloud_risk_fields(
    entry: float | None,
    ema_10m: dict[str, float | None],
    risk_amount: float = A_PLUS_PLUS_MAX_RISK,
) -> dict[str, Any]:
    ema34 = ema_10m.get("34")
    ema50 = ema_10m.get("50")
    if entry is None or ema34 is None or ema50 is None:
        return {}
    stop_cloud_low = min(ema34, ema50)
    stop_cloud_high = max(ema34, ema50)
    stop_buffer = A_PLUS_PLUS_STOP_BUFFER
    risk_plan = fixed_stop_risk_plan(
        entry=entry,
        stop=stop_cloud_low - stop_buffer,
        max_risk=risk_amount,
        stop_buffer=stop_buffer,
        stop_mode="10m-34-50-cloud",
    )
    return {
        "stop_cloud_low": round(stop_cloud_low, 4),
        "stop_cloud_high": round(stop_cloud_high, 4),
        **({"risk_plan": risk_plan} if risk_plan else {}),
    }


def a_plus_plus_risk_plan(
    entry: float,
    cloud_low: float,
    cloud_high: float,
    trend: str,
    daily_candles: list[dict[str, Any]] | None = None,
    risk_amount: float = A_PLUS_PLUS_MAX_RISK,
    stop_mode: str = A_PLUS_PLUS_STOP_MODE_FIXED,
    fixed_stop_buffer: float = A_PLUS_PLUS_STOP_BUFFER,
) -> dict[str, Any] | None:
    volatility = daily_volatility(daily_candles or [], entry)
    stop_buffer = stop_buffer_for_mode(stop_mode, fixed_stop_buffer, volatility)
    if trend == "Bullish":
        stop = cloud_low - stop_buffer
    elif trend == "Bearish":
        stop = cloud_high + stop_buffer
    else:
        return None

    risk_per_share = abs(entry - stop)
    if risk_per_share <= 0:
        return None

    max_risk = max(1, float(risk_amount or A_PLUS_PLUS_MAX_RISK))
    shares = int(max_risk // risk_per_share)

    return {
        "entry": round(entry, 4),
        "stop": round(stop, 4),
        "stop_buffer": round(stop_buffer, 4),
        "stop_mode": stop_mode if stop_mode == A_PLUS_PLUS_STOP_MODE_AUTO else A_PLUS_PLUS_STOP_MODE_FIXED,
        "risk_per_share": round(risk_per_share, 4),
        "max_risk": round(max_risk, 2),
        "shares": shares,
        "volatility": volatility,
    }


def stop_buffer_for_mode(stop_mode: str, fixed_stop_buffer: float, volatility: dict[str, Any]) -> float:
    if stop_mode == A_PLUS_PLUS_STOP_MODE_AUTO:
        average_range = volatility.get("average_range")
        if average_range is not None:
            return round(min(5, max(0.25, float(average_range) * 0.12)), 4)
    return round(max(0.05, float(fixed_stop_buffer or A_PLUS_PLUS_STOP_BUFFER)), 4)


def daily_volatility(candles: list[dict[str, Any]], price: float | None) -> dict[str, Any]:
    sample = candles[-3:]
    ranges = [
        abs(candle["high"] - candle["low"])
        for candle in sample
        if candle.get("high") is not None and candle.get("low") is not None
    ]
    if not ranges or not price:
        return {"grade": "unknown", "average_range": None, "average_range_pct": None, "sample_size": len(ranges)}

    average_range = sum(ranges) / len(ranges)
    average_range_pct = average_range / price * 100
    if average_range_pct >= 7:
        grade = "fast"
    elif average_range_pct >= 3.5:
        grade = "normal"
    else:
        grade = "slow"
    return {
        "grade": grade,
        "average_range": round(average_range, 4),
        "average_range_pct": round(average_range_pct, 2),
        "sample_size": len(ranges),
    }


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
    return latest_confirmed_ten_minute_candle(candles)


def latest_ten_minute_candle(candles: list[dict[str, Any]]) -> dict[str, Any] | None:
    return candles[-1] if candles else None


def previous_ten_minute_candle(candles: list[dict[str, Any]]) -> dict[str, Any] | None:
    if len(candles) < 2:
        return None
    return candles[-2]


def latest_confirmed_ten_minute_candle(candles: list[dict[str, Any]]) -> dict[str, Any] | None:
    for candle in reversed(candles):
        if is_complete_ten_minute_candle(candle):
            return candle
    return None


def previous_confirmed_ten_minute_candle(
    candles: list[dict[str, Any]],
    current_candle: dict[str, Any],
) -> dict[str, Any] | None:
    current_key = candle_time_key(current_candle)
    seen_current = False
    for candle in reversed(candles):
        if not seen_current:
            if candle is current_candle or candle_time_key(candle) == current_key:
                seen_current = True
            continue
        if is_complete_ten_minute_candle(candle):
            return candle
    return None


def is_complete_ten_minute_candle(candle: dict[str, Any]) -> bool:
    source_count = candle.get("source_count")
    return source_count is None or source_count >= 2


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
