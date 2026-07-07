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
WEBULL_BATCH_BAR_LIMIT = 20
A_PLUS_PLUS_MAX_RISK = 100
A_PLUS_PLUS_STOP_BUFFER = 1
A_PLUS_PLUS_STOP_MODE_FIXED = "fixed"
A_PLUS_PLUS_STOP_MODE_AUTO = "auto"

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
        ten_minute_ema = ema_values(ten_minute_candles, [5, 12, 34, 50])
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
    ema_1h: dict[str, float | None],
    ema_daily: dict[str, float | None],
    previous_price: float | None = None,
    current_high: float | None = None,
    current_low: float | None = None,
    candle_complete: bool = True,
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
            "low": round(low, 4),
            "high": round(high, 4),
            "trend": trend,
            "trade_action": trade_action_for_trend(trend),
            "type": "mtf_cloud_breakout",
        }
        if trend == "Bullish":
            if candle_complete and previous_price is not None and previous_price <= high and price > high:
                matches.append({**match, "status": "confirmed", "direction": "above"})
            elif not candle_complete and previous_price is not None and previous_price <= high and candle_touches_cloud(current_low, current_high, low, high):
                matches.append({**match, "status": "waiting", "direction": "above"})
        elif trend == "Bearish":
            if candle_complete and previous_price is not None and previous_price >= low and price < low:
                matches.append({**match, "status": "confirmed", "direction": "below"})
            elif not candle_complete and previous_price is not None and previous_price >= low and candle_touches_cloud(current_low, current_high, low, high):
                matches.append({**match, "status": "waiting", "direction": "below"})
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
) -> list[dict[str, Any]]:
    if ten_minute_trend == "Chop":
        return []
    candle = latest_ten_minute_candle(ten_minute_candles)
    if not candle:
        return []
    status = "confirmed" if is_complete_ten_minute_candle(candle) else "waiting"
    candle_time = candle.get("time") or candle.get("sort_time") or candle.get("timestamp")
    previous_candle = previous_ten_minute_candle(ten_minute_candles)
    previous_price = previous_candle.get("close") if previous_candle else None
    candle_high = candle.get("high")
    candle_low = candle.get("low")
    matches = [
        *mtf_matches(
            price,
            ten_minute_trend,
            ema_1h,
            ema_daily,
            previous_price=previous_price,
            current_high=candle_high,
            current_low=candle_low,
            candle_complete=status == "confirmed",
        ),
        *ema_cloud_bounce_matches(
            ten_minute_candles,
            ema_10m,
            ema_1h,
            ema_daily,
            daily_candles=daily_candles,
            risk_amount=risk_amount,
            stop_mode=stop_mode,
            fixed_stop_buffer=fixed_stop_buffer,
        ),
    ]
    visible_matches = []
    for match in matches:
        if is_immediate_alert_match(match):
            match["status"] = "confirmed"
        elif status == "waiting":
            if match.get("type") == "mtf_cloud_breakout" and match.get("status") == "confirmed":
                continue
            match["status"] = "waiting"
        else:
            match.setdefault("status", "confirmed")
        if candle_time is not None:
            match.setdefault("candle_time", candle_time)
        visible_matches.append(match)
    return visible_matches


def candle_touches_cloud(
    candle_low: float | None,
    candle_high: float | None,
    cloud_low: float,
    cloud_high: float,
) -> bool:
    if candle_low is None or candle_high is None:
        return False
    return candle_low <= cloud_high and candle_high >= cloud_low


def is_immediate_alert_match(match: dict[str, Any]) -> bool:
    return match.get("label") == "10m bounce 34/50" and match.get("type") == "10m_cloud_bounce"


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
    risk_amount: float = A_PLUS_PLUS_MAX_RISK,
    stop_mode: str = A_PLUS_PLUS_STOP_MODE_FIXED,
    fixed_stop_buffer: float = A_PLUS_PLUS_STOP_BUFFER,
) -> list[dict[str, Any]]:
    candle = latest_ten_minute_candle(ten_minute_candles)
    if not candle:
        return []

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
        touched_cloud = low <= cloud_high and high >= cloud_low
        if timeframe == "10m":
            if trend_value not in {"Bullish", "Bearish"} or not touched_cloud:
                continue
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
                    "timeframe": timeframe,
                    "cloud_low": round(cloud_low, 4),
                    "cloud_high": round(cloud_high, 4),
                    "candle_low": round(low, 4),
                    "candle_high": round(high, 4),
                    "candle_close": round(close, 4),
                    "candle_time": candle_time,
                    "type": "10m_cloud_bounce",
                    "trend": trend_value,
                    "trade_action": trade_action,
                    **({"risk_plan": risk_plan} if risk_plan else {}),
                }
            )
            continue
        if trend_value == "Bullish":
            confirmed_bounce = close > cloud_high
        elif trend_value == "Bearish":
            confirmed_bounce = close < cloud_low
        else:
            confirmed_bounce = False
        if touched_cloud and confirmed_bounce:
            matches.append(
                {
                    "label": label,
                    "timeframe": timeframe,
                    "cloud_low": round(cloud_low, 4),
                    "cloud_high": round(cloud_high, 4),
                    "candle_low": round(low, 4),
                    "candle_high": round(high, 4),
                    "candle_close": round(close, 4),
                    "candle_time": candle_time,
                    "type": "10m_cloud_bounce",
                    "trend": trend_value,
                    "trade_action": trade_action,
                }
            )
    return matches


def trade_action_for_trend(trend: str | None) -> str | None:
    if trend == "Bullish":
        return "Long"
    if trend == "Bearish":
        return "Short"
    return None


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
