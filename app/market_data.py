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
MIN_ENTRY_REWARD_RISK = 2
A_PLUS_PLUS_STOP_MODE_FIXED = "fixed"
A_PLUS_PLUS_STOP_MODE_AUTO = "auto"
MTF_RESISTANCE_DISTANCE_PCT = 1.5
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
        proximity = mtf_proximity(price, ema_1h, ema_daily, daily_candles)
        support_resistance = support_resistance_levels(price, h1_candles, daily_candles, ema_1h, ema_daily)
        matches = mtf_signal_matches(
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
        )
        plan = trade_plan_from_levels(
            price,
            ten_minute_trend,
            support_resistance,
            matches,
            risk_amount=risk_amount,
            fixed_stop_buffer=fixed_stop_buffer,
        )
        read = scanner_read(price, ten_minute_trend, ten_minute_ema, proximity, matches)
        thesis = trade_thesis_from_gates(
            price,
            ten_minute_trend,
            support_resistance,
            matches,
            plan,
            read,
            fixed_stop_buffer=fixed_stop_buffer,
        )
        alert_matches = [*matches]
        playable_match = playable_trade_alert_match(symbol, price, ten_minute_trend, plan, thesis, read)
        if playable_match:
            alert_matches.append(playable_match)
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
                "mtf_proximity": proximity,
                "support_resistance": support_resistance,
                "mtf_matches": alert_matches,
                "trade_plan": plan,
                "trade_thesis": thesis,
                "scanner_read": read,
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
    latest_candle = latest_ten_minute_candle(ten_minute_candles)
    latest_candle_time = candle_time_key(latest_candle) if latest_candle else None
    return [
        *long_mtf_pullback_matches(
            ten_minute_trend,
            ten_minute_candles,
            ema_10m,
            ema_1h,
            ema_daily,
            risk_amount=risk_amount,
            fixed_stop_buffer=fixed_stop_buffer,
        ),
        *ten_minute_34_50_bounce_matches(ten_minute_candles, ema_1h, ema_daily, risk_amount=risk_amount, fixed_stop_buffer=fixed_stop_buffer),
        *mtf_cloud_touch_matches(
            live_price,
            ema_1h,
            ema_daily,
            latest_candle=latest_candle,
            candle_time=latest_candle_time,
            risk_amount=risk_amount,
            fixed_stop_buffer=fixed_stop_buffer,
        ),
    ]


def mtf_cloud_touch_matches(
    price: float | None,
    ema_1h: dict[str, float | None],
    ema_daily: dict[str, float | None],
    latest_candle: dict[str, Any] | None = None,
    candle_time: Any = None,
    risk_amount: float = A_PLUS_PLUS_MAX_RISK,
    fixed_stop_buffer: float = A_PLUS_PLUS_STOP_BUFFER,
) -> list[dict[str, Any]]:
    if not latest_candle or not is_complete_ten_minute_candle(latest_candle):
        return []

    matches = []
    candle_low = latest_candle.get("low")
    candle_high = latest_candle.get("high")
    candle_close = latest_candle.get("close")
    if candle_low is None or candle_high is None or candle_close is None:
        return []

    for check in LONG_MTF_CLOUDS:
        ema_set = ema_1h if check["source"] == "hourly" else ema_daily
        first = ema_set.get(check["keys"][0])
        second = ema_set.get(check["keys"][1])
        if first is None or second is None:
            continue
        cloud_low = min(first, second)
        cloud_high = max(first, second)
        if not candle_touches_cloud(candle_low, candle_high, cloud_low, cloud_high):
            continue
        direction = mtf_touch_reaction_direction(candle_close, cloud_low, cloud_high)
        if not direction:
            continue
        is_long = direction == "bounce_up"
        stop = cloud_low - fixed_stop_buffer if is_long else cloud_high + fixed_stop_buffer
        risk_plan = fixed_stop_risk_plan(
            entry=candle_close,
            stop=stop,
            max_risk=risk_amount,
            stop_buffer=fixed_stop_buffer,
            stop_mode="mtf-cloud-touch",
        )
        action_word = "bounced up from" if is_long else "rejected down from"
        matches.append(
            {
                "label": check["label"],
                "display_label": f"{check['label']} {action_word}",
                "cloud_label": check["label"],
                "timeframe": check["timeframe"],
                "cloud_low": round(cloud_low, 4),
                "cloud_high": round(cloud_high, 4),
                "candle_low": round(candle_low, 4),
                "candle_high": round(candle_high, 4),
                "candle_close": round(candle_close, 4),
                "entry_price": round(candle_close, 4),
                "last_price": round(price, 4) if price is not None else None,
                "stop_cloud_low": round(cloud_low, 4),
                "stop_cloud_high": round(cloud_high, 4),
                **({"risk_plan": risk_plan} if risk_plan else {}),
                "candle_time": candle_time,
                "type": "mtf_cloud_price_touch",
                "status": "confirmed",
                "direction": direction,
                "trade_action": "Long" if is_long else "Short",
            }
        )
    return matches


def mtf_touch_reaction_direction(price: float, cloud_low: float, cloud_high: float) -> str | None:
    if price > cloud_high:
        return "bounce_up"
    if price < cloud_low:
        return "reject_down"
    return None


def mtf_proximity(
    price: float | None,
    ema_1h: dict[str, float | None],
    ema_daily: dict[str, float | None],
    daily_candles: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    volatility = daily_volatility(daily_candles or [], price)
    range_unit = volatility.get("average_range")
    clouds = []
    for check in LONG_MTF_CLOUDS:
        ema_set = ema_1h if check["source"] == "hourly" else ema_daily
        first = ema_set.get(check["keys"][0])
        second = ema_set.get(check["keys"][1])
        if price is None or first is None or second is None:
            continue

        cloud_low = min(first, second)
        cloud_high = max(first, second)
        distance, direction = distance_to_cloud(price, cloud_low, cloud_high)
        distance_pct = (distance / price * 100) if price else None
        range_ratio = (distance / range_unit) if range_unit else None
        clouds.append(
            {
                "label": check["label"],
                "timeframe": check["timeframe"],
                "cloud_low": round(cloud_low, 4),
                "cloud_high": round(cloud_high, 4),
                "direction": direction,
                "distance": round(distance, 4),
                "distance_pct": round(distance_pct, 2) if distance_pct is not None else None,
                "range_ratio": round(range_ratio, 2) if range_ratio is not None else None,
                "status": mtf_proximity_status(distance, range_ratio),
            }
        )

    clouds.sort(key=lambda cloud: (cloud["distance"], cloud["label"]))
    return {
        "nearest": clouds[0] if clouds else None,
        "clouds": clouds,
        "range_unit": round(range_unit, 4) if range_unit is not None else None,
        "range_unit_pct": volatility.get("average_range_pct"),
        "range_sample_size": volatility.get("sample_size", 0),
    }


def distance_to_cloud(price: float, cloud_low: float, cloud_high: float) -> tuple[float, str]:
    if cloud_low <= price <= cloud_high:
        return 0, "inside"
    if price < cloud_low:
        return cloud_low - price, "above"
    return price - cloud_high, "below"


def mtf_proximity_status(distance: float, range_ratio: float | None) -> str:
    if distance <= 0:
        return "inside"
    if range_ratio is None:
        return "unknown"
    if range_ratio <= 0.25:
        return "hot"
    if range_ratio <= 0.5:
        return "near"
    if range_ratio <= 1:
        return "reachable"
    return "far"


def support_resistance_levels(
    price: float | None,
    hourly_candles: list[dict[str, Any]],
    daily_candles: list[dict[str, Any]],
    ema_1h: dict[str, float | None],
    ema_daily: dict[str, float | None],
) -> dict[str, Any]:
    levels = [
        *ema_cloud_levels(price, ema_1h, "Hourly 34/50", "1h", ("34", "50")),
        *ema_cloud_levels(price, ema_daily, "Daily 20/21", "daily", ("20", "21")),
        *ema_cloud_levels(price, ema_daily, "Daily 50/55", "daily", ("50", "55")),
        *swing_levels(price, hourly_candles, "1h", lookback=96),
        *swing_levels(price, daily_candles, "daily", lookback=120),
    ]
    levels = dedupe_price_levels(levels)
    support = [level for level in levels if level.get("side") in {"support", "inside"}]
    resistance = [level for level in levels if level.get("side") in {"resistance", "inside"}]
    support.sort(key=lambda level: level_sort_key(level, price))
    resistance.sort(key=lambda level: level_sort_key(level, price))
    return {
        "support": support[:6],
        "resistance": resistance[:6],
        "levels": levels[:16],
    }


def ema_cloud_levels(
    price: float | None,
    ema_set: dict[str, float | None],
    label: str,
    timeframe: str,
    keys: tuple[str, str],
) -> list[dict[str, Any]]:
    first = ema_set.get(keys[0])
    second = ema_set.get(keys[1])
    if price is None or first is None or second is None or price <= 0:
        return []
    low = min(first, second)
    high = max(first, second)
    side = level_side(price, low, high)
    distance = level_distance(price, low, high)
    return [
        {
            "label": label,
            "timeframe": timeframe,
            "kind": "ema_cloud",
            "side": side,
            "low": round(low, 4),
            "high": round(high, 4),
            "price": round((low + high) / 2, 4),
            "distance": round(distance, 4),
            "distance_pct": round(distance / price * 100, 2),
            "strength": 3 if timeframe == "daily" else 2,
        }
    ]


def swing_levels(
    price: float | None,
    candles: list[dict[str, Any]],
    timeframe: str,
    lookback: int,
) -> list[dict[str, Any]]:
    if price is None or price <= 0:
        return []
    recent = candles[-lookback:]
    levels: list[dict[str, Any]] = []
    for index, candle in enumerate(recent):
        high = candle.get("high")
        low = candle.get("low")
        if high is not None and is_swing_high(recent, index):
            levels.append(swing_level(price, high, high, timeframe, "swing_high", candle_time_key(candle)))
        if low is not None and is_swing_low(recent, index):
            levels.append(swing_level(price, low, low, timeframe, "swing_low", candle_time_key(candle)))
    return levels


def swing_level(
    price: float,
    low: float,
    high: float,
    timeframe: str,
    kind: str,
    touched_at: Any,
) -> dict[str, Any]:
    side = level_side(price, low, high)
    distance = level_distance(price, low, high)
    return {
        "label": f"{timeframe.upper()} {'high' if kind == 'swing_high' else 'low'}",
        "timeframe": timeframe,
        "kind": kind,
        "side": side,
        "low": round(low, 4),
        "high": round(high, 4),
        "price": round((low + high) / 2, 4),
        "distance": round(distance, 4),
        "distance_pct": round(distance / price * 100, 2),
        "strength": 2 if timeframe == "daily" else 1,
        "touched_at": touched_at,
    }


def is_swing_high(candles: list[dict[str, Any]], index: int, window: int = 2) -> bool:
    value = candles[index].get("high")
    if value is None or index < window or index >= len(candles) - window:
        return False
    neighbors = candles[index - window:index] + candles[index + 1:index + window + 1]
    highs = [candle.get("high") for candle in neighbors if candle.get("high") is not None]
    return bool(highs) and all(value >= high for high in highs)


def is_swing_low(candles: list[dict[str, Any]], index: int, window: int = 2) -> bool:
    value = candles[index].get("low")
    if value is None or index < window or index >= len(candles) - window:
        return False
    neighbors = candles[index - window:index] + candles[index + 1:index + window + 1]
    lows = [candle.get("low") for candle in neighbors if candle.get("low") is not None]
    return bool(lows) and all(value <= low for low in lows)


def level_side(price: float, low: float, high: float) -> str:
    if low <= price <= high:
        return "inside"
    if price < low:
        return "resistance"
    return "support"


def level_distance(price: float, low: float, high: float) -> float:
    if low <= price <= high:
        return 0
    if price < low:
        return low - price
    return price - high


def level_sort_key(level: dict[str, Any], price: float | None) -> tuple[float, int, str]:
    distance = level.get("distance")
    parsed_distance = float(distance) if distance is not None else float("inf")
    return (parsed_distance, -int(level.get("strength") or 0), str(level.get("label") or ""))


def dedupe_price_levels(levels: list[dict[str, Any]]) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    for level in sorted(levels, key=lambda item: (-int(item.get("strength") or 0), float(item.get("distance") or 0))):
        level_price = float(level.get("price") or 0)
        duplicate = next(
            (
                existing
                for existing in selected
                if existing.get("side") == level.get("side")
                and existing.get("timeframe") == level.get("timeframe")
                and abs(float(existing.get("price") or 0) - level_price) <= max(0.03, level_price * 0.0015)
            ),
            None,
        )
        if duplicate:
            continue
        selected.append(level)
    selected.sort(key=lambda item: (float(item.get("distance") or 0), -int(item.get("strength") or 0), str(item.get("label") or "")))
    return selected


def trade_plan_from_levels(
    price: float | None,
    ten_minute_trend: str,
    support_resistance: dict[str, Any],
    matches: list[dict[str, Any]],
    risk_amount: float = A_PLUS_PLUS_MAX_RISK,
    fixed_stop_buffer: float = A_PLUS_PLUS_STOP_BUFFER,
) -> dict[str, Any] | None:
    action = trade_action_for_trend(ten_minute_trend)
    if price is None or price <= 0 or action is None:
        return None
    source_match = best_trade_plan_match(matches, action)
    entry = source_match.get("entry_price") if source_match else price
    if entry is None:
        entry = price
    entry = float(entry)
    if entry <= 0:
        return None
    levels = support_resistance or {}
    if action == "Long":
        stop_level = first_level(levels.get("support", []), entry, "support")
        target_level = first_level(levels.get("resistance", []), entry, "resistance")
        if not stop_level or not target_level:
            return pending_trade_plan(action, entry, stop_level, target_level, source_match)
        stop = min(float(stop_level["low"]), float(stop_level["high"])) - fixed_stop_buffer
        target = min(float(target_level["low"]), float(target_level["high"]))
        risk_per_share = entry - stop
        reward_per_share = target - entry
    else:
        stop_level = first_level(levels.get("resistance", []), entry, "resistance")
        target_level = first_level(levels.get("support", []), entry, "support")
        if not stop_level or not target_level:
            return pending_trade_plan(action, entry, stop_level, target_level, source_match)
        stop = max(float(stop_level["low"]), float(stop_level["high"])) + fixed_stop_buffer
        target = max(float(target_level["low"]), float(target_level["high"]))
        risk_per_share = stop - entry
        reward_per_share = entry - target
    if risk_per_share <= 0 or reward_per_share <= 0:
        return pending_trade_plan(action, entry, stop_level, target_level, source_match)
    rr = reward_per_share / risk_per_share
    targets = target_plans_from_levels(action, entry, risk_per_share, levels, target_level)
    risk_plan = fixed_stop_risk_plan(
        entry=entry,
        stop=stop,
        max_risk=risk_amount,
        stop_buffer=fixed_stop_buffer,
        stop_mode="support-resistance",
    )
    return {
        "action": action,
        "entry": round(entry, 4),
        "stop": round(stop, 4),
        "target": round(target, 4),
        "risk_per_share": round(risk_per_share, 4),
        "reward_per_share": round(reward_per_share, 4),
        "reward_risk": round(rr, 2),
        "grade": trade_plan_grade(rr),
        "targets": targets,
        "minimum_reward_risk": MIN_ENTRY_REWARD_RISK,
        "is_acceptable": rr >= MIN_ENTRY_REWARD_RISK,
        "has_acceptable_target": any(target.get("is_acceptable") for target in targets),
        "stop_level": compact_level(stop_level),
        "target_level": compact_level(target_level),
        "source_match_type": source_match.get("type") if source_match else None,
        "source_match_label": source_match.get("display_label") or source_match.get("label") if source_match else None,
        "risk_plan": risk_plan,
    }


def best_trade_plan_match(matches: list[dict[str, Any]], action: str) -> dict[str, Any] | None:
    candidates = [
        match
        for match in matches
        if match.get("trade_action") == action
        and match.get("type") in {"long_mtf_5_12_touch", "10m_34_50_bounce", "mtf_cloud_price_touch"}
        and match.get("setup_quality") != "bad"
    ]
    priority = {"long_mtf_5_12_touch": 0, "10m_34_50_bounce": 1, "mtf_cloud_price_touch": 2}
    candidates.sort(key=lambda match: (priority.get(str(match.get("type")), 99), str(match.get("label") or "")))
    return candidates[0] if candidates else None


def target_plans_from_levels(
    action: str,
    entry: float,
    risk_per_share: float,
    levels: dict[str, Any],
    primary_target_level: dict[str, Any],
) -> list[dict[str, Any]]:
    if risk_per_share <= 0:
        return []
    side = "resistance" if action == "Long" else "support"
    target_levels = [
        level
        for level in levels.get(side, [])
        if level.get("low") is not None and level.get("high") is not None
    ]
    if primary_target_level not in target_levels:
        target_levels.insert(0, primary_target_level)
    targets = []
    for level in target_levels:
        low = float(level["low"])
        high = float(level["high"])
        target_price = low if action == "Long" else high
        reward = target_price - entry if action == "Long" else entry - target_price
        if reward <= 0:
            continue
        rr = reward / risk_per_share
        targets.append(
            {
                "price": round(target_price, 4),
                "label": level.get("label"),
                "timeframe": level.get("timeframe"),
                "reward_per_share": round(reward, 4),
                "reward_risk": round(rr, 2),
                "grade": trade_plan_grade(rr),
                "is_acceptable": rr >= MIN_ENTRY_REWARD_RISK,
            }
        )
    targets.sort(key=lambda target: (target["price"] if action == "Long" else -target["price"]))
    return targets[:4]


def first_level(levels: list[dict[str, Any]], entry: float, side: str) -> dict[str, Any] | None:
    filtered = []
    for level in levels:
        low = level.get("low")
        high = level.get("high")
        if low is None or high is None:
            continue
        low_value = float(low)
        high_value = float(high)
        if side == "support" and high_value < entry:
            filtered.append(level)
        elif side == "resistance" and low_value > entry:
            filtered.append(level)
    filtered.sort(key=lambda level: (abs(entry - float(level.get("price") or entry)), -int(level.get("strength") or 0)))
    return filtered[0] if filtered else None


def pending_trade_plan(
    action: str,
    entry: float,
    stop_level: dict[str, Any] | None,
    target_level: dict[str, Any] | None,
    source_match: dict[str, Any] | None,
) -> dict[str, Any]:
    return {
        "action": action,
        "entry": round(entry, 4),
        "grade": "incomplete",
        "minimum_reward_risk": MIN_ENTRY_REWARD_RISK,
        "is_acceptable": False,
        "stop_level": compact_level(stop_level) if stop_level else None,
        "target_level": compact_level(target_level) if target_level else None,
        "source_match_type": source_match.get("type") if source_match else None,
        "source_match_label": source_match.get("display_label") or source_match.get("label") if source_match else None,
    }


def trade_thesis_from_gates(
    price: float | None,
    ten_minute_trend: str,
    support_resistance: dict[str, Any],
    matches: list[dict[str, Any]],
    plan: dict[str, Any] | None,
    read: dict[str, Any],
    fixed_stop_buffer: float = A_PLUS_PLUS_STOP_BUFFER,
) -> dict[str, Any]:
    action = trade_action_for_trend(ten_minute_trend)
    if price is None or price <= 0 or action is None:
        return trade_thesis_payload(
            decision="Skip",
            bias=action,
            setup=False,
            confirmation=False,
            reward_risk=False,
            reason=f"{ten_minute_trend or 'No'} trend",
            detail="No directional setup yet. Scanner waits for a bullish or bearish 10m trend before planning a trade.",
            plan=plan,
        )

    source_match = best_trade_plan_match(matches, action)
    setup_ok = bool(plan or source_match or read.get("kind") in {"wait", "entry"})
    confirmation_ok = read.get("kind") == "entry" or bool(source_match)
    rr_ok = bool(plan and (plan.get("is_acceptable") or plan.get("has_acceptable_target")))
    invalidated = trade_plan_invalidated(price, action, plan)

    if invalidated:
        decision = "Skip"
        reason = "invalidation broken"
        detail = "Price is through the planned invalidation level, so the setup is no longer playable."
    elif not setup_ok:
        decision = "Skip"
        reason = "no setup"
        detail = "No actionable setup is visible from the current trend, support/resistance, and signal rules."
    elif not confirmation_ok:
        decision = "Wait"
        reason = read.get("reason") or "needs confirmation"
        detail = read.get("detail") or "Setup exists, but price has not confirmed the trigger yet."
    elif not rr_ok:
        decision = "Wait" if plan and plan.get("grade") == "thin" else "Skip"
        reason = "R:R not ready"
        detail = "The setup is confirmed, but reward-to-risk is not strong enough from the current entry."
    else:
        decision = "Playable"
        reason = "confirmed + R:R"
        detail = "Setup is confirmed and at least one target gives acceptable reward-to-risk."

    return trade_thesis_payload(
        decision=decision,
        bias=action,
        setup=setup_ok,
        confirmation=confirmation_ok,
        reward_risk=rr_ok,
        reason=reason,
        detail=detail,
        plan=plan,
        source_match=source_match,
        read=read,
        support_resistance=support_resistance,
    )


def trade_plan_invalidated(price: float, action: str, plan: dict[str, Any] | None) -> bool:
    if not plan or plan.get("stop") is None:
        return False
    stop = float(plan["stop"])
    if action == "Long":
        return price <= stop
    if action == "Short":
        return price >= stop
    return False


def trade_thesis_payload(
    decision: str,
    bias: str | None,
    setup: bool,
    confirmation: bool,
    reward_risk: bool,
    reason: str,
    detail: str,
    plan: dict[str, Any] | None,
    source_match: dict[str, Any] | None = None,
    read: dict[str, Any] | None = None,
    support_resistance: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "decision": decision,
        "bias": bias,
        "reason": reason,
        "detail": detail,
        "setup": {
            "status": setup,
            "label": setup_label(source_match, read, support_resistance),
        },
        "confirmation": {
            "status": confirmation,
            "label": confirmation_label(confirmation, read, source_match),
        },
        "reward_risk": {
            "status": reward_risk,
            "label": reward_risk_label(plan),
        },
        "entry": plan.get("entry") if plan else None,
        "invalidation": plan.get("stop") if plan else None,
        "targets": plan.get("targets", []) if plan else [],
    }


def setup_label(
    source_match: dict[str, Any] | None,
    read: dict[str, Any] | None,
    support_resistance: dict[str, Any] | None,
) -> str:
    if source_match:
        return str(source_match.get("display_label") or source_match.get("label") or "Confirmed setup")
    if read and read.get("kind") in {"wait", "entry"}:
        return str(read.get("reason") or "Setup forming")
    nearest_support = (support_resistance or {}).get("support", [None])[0] if (support_resistance or {}).get("support") else None
    nearest_resistance = (support_resistance or {}).get("resistance", [None])[0] if (support_resistance or {}).get("resistance") else None
    if nearest_support and nearest_resistance:
        return "Directional setup with nearby levels"
    return "No setup"


def confirmation_label(
    confirmation: bool,
    read: dict[str, Any] | None,
    source_match: dict[str, Any] | None,
) -> str:
    if confirmation:
        return str((source_match or {}).get("display_label") or (read or {}).get("reason") or "Confirmed")
    return str((read or {}).get("reason") or "Needs trigger")


def reward_risk_label(plan: dict[str, Any] | None) -> str:
    if not plan:
        return "Needs levels"
    targets = plan.get("targets") or []
    acceptable = next((target for target in targets if target.get("is_acceptable")), None)
    if acceptable:
        return f"{acceptable.get('reward_risk')}R to {acceptable.get('label') or 'target'}"
    rr = plan.get("reward_risk")
    if rr is not None:
        return f"{rr}R"
    return "Needs target"


def playable_trade_alert_match(
    symbol: str,
    price: float | None,
    ten_minute_trend: str,
    plan: dict[str, Any] | None,
    thesis: dict[str, Any] | None,
    read: dict[str, Any] | None,
) -> dict[str, Any] | None:
    if not plan or not thesis or str(thesis.get("decision") or "").lower() != "playable":
        return None
    target = first_acceptable_target(plan) or first_plan_target(plan)
    entry = plan.get("entry") if plan.get("entry") is not None else price
    rr = target.get("reward_risk") if target else plan.get("reward_risk")
    action = plan.get("action") or thesis.get("bias") or trade_action_for_trend(ten_minute_trend)
    if entry is None:
        return None
    parsed_rr = safe_float(rr)
    rr_text = f"{parsed_rr:.2f}R" if parsed_rr is not None else "R:R ready"
    target_label = target.get("label") if target else plan.get("target_level", {}).get("label")
    display_label = f"Playable: {action or 'Trade'} {rr_text}"
    if target_label:
        display_label = f"{display_label} to {target_label}"
    return {
        "type": "playable_trade",
        "status": "confirmed",
        "label": "Playable Trade",
        "display_label": display_label,
        "trade_action": action,
        "trend": ten_minute_trend,
        "symbol": symbol,
        "entry_price": round(float(entry), 4),
        "stop_price": plan.get("stop"),
        "target_price": target.get("price") if target else plan.get("target"),
        "reward_risk": round(parsed_rr, 2) if parsed_rr is not None else None,
        "risk_plan": plan.get("risk_plan"),
        "source_type": plan.get("source_match_type"),
        "source_label": plan.get("source_match_label"),
        "candle_time": (read or {}).get("candle_time"),
        "scanner_read": read,
    }


def safe_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def first_acceptable_target(plan: dict[str, Any]) -> dict[str, Any] | None:
    return next((target for target in plan.get("targets", []) if target.get("is_acceptable")), None)


def first_plan_target(plan: dict[str, Any]) -> dict[str, Any] | None:
    targets = plan.get("targets") or []
    return targets[0] if targets else None


def trade_plan_grade(reward_risk: float) -> str:
    if reward_risk >= 3:
        return "excellent"
    if reward_risk >= MIN_ENTRY_REWARD_RISK:
        return "good"
    if reward_risk >= 1:
        return "thin"
    return "poor"


def compact_level(level: dict[str, Any]) -> dict[str, Any]:
    return {
        "label": level.get("label"),
        "timeframe": level.get("timeframe"),
        "kind": level.get("kind"),
        "side": level.get("side"),
        "low": level.get("low"),
        "high": level.get("high"),
        "distance_pct": level.get("distance_pct"),
    }


def scanner_read(
    price: float | None,
    ten_minute_trend: str,
    ema_10m: dict[str, float | None],
    proximity: dict[str, Any],
    matches: list[dict[str, Any]],
) -> dict[str, Any]:
    if ten_minute_trend not in {"Bullish", "Bearish"}:
        return scanner_read_payload("skip", "Skip", f"{ten_minute_trend or 'No'} trend", "Scanner waits for a bullish or bearish 10m trend.")

    trade_action = trade_action_for_trend(ten_minute_trend)
    good_entry_match = next(
        (
            match
            for match in matches
            if match.get("trade_action") == trade_action
            and match.get("type") in {"long_mtf_5_12_touch", "10m_34_50_bounce"}
            and match.get("setup_quality") != "bad"
        ),
        None,
    )
    bad_bounce = next(
        (
            match
            for match in matches
            if match.get("type") == "10m_34_50_bounce" and match.get("setup_quality") == "bad"
        ),
        None,
    )
    touch_match = next((match for match in matches if match.get("type") == "mtf_cloud_price_touch"), None)
    entry_cloud = entry_cloud_distance(price, ema_10m)
    resistance = nearest_mtf_resistance(proximity)
    support = nearest_mtf_support(proximity)

    if ten_minute_trend == "Bearish":
        return bearish_scanner_read(good_entry_match, bad_bounce, touch_match, entry_cloud, resistance, support)

    if resistance and resistance.get("direction") == "inside":
        label = short_mtf_label(resistance.get("label"))
        return scanner_read_payload("wait", "Wait", f"clear {label}", "Price is inside an MTF cloud. Treat it as resistance until price clears above it.", resistance=resistance)

    if resistance:
        label = short_mtf_label(resistance.get("label"))
        return scanner_read_payload("wait", "Wait", f"break {label}", "Nearest MTF cloud is still overhead resistance. A clean move above it makes the read more bullish.", resistance=resistance)

    if bad_bounce and not good_entry_match:
        return scanner_read_payload("skip", "Skip", "weak bounce", bad_bounce.get("setup_quality_note") or "The 10m 34/50 bounce is marked low quality.", source_match=bad_bounce)

    if not entry_cloud:
        return scanner_read_payload("wait", "Wait", "need 5/12", "The scanner needs the 10m 5/12 EMA cloud to judge the entry.")

    if entry_cloud["status"] == "extended":
        detail = (
            f"Price is above MTF clouds and {short_mtf_label(support.get('label'))} is acting as support, but entry should wait for the 10m 5/12 EMA cloud."
            if support
            else "Price is bullish but extended above the 10m 5/12 EMA cloud. Wait for the entry pullback."
        )
        return scanner_read_payload("wait", "Wait", "pullback 5/12", detail, support=support, entry_cloud=entry_cloud)

    if entry_cloud["status"] == "below":
        return scanner_read_payload("wait", "Wait", "reclaim 5/12", "Price is below the 10m 5/12 EMA cloud. Wait for reclaim before considering a long entry.", entry_cloud=entry_cloud)

    if good_entry_match:
        detail = (
            f"{display_match_name(good_entry_match)} with price inside the 10m 5/12 EMA cloud. MTF cloud below is support."
            if support
            else f"{display_match_name(good_entry_match)} with price inside the 10m 5/12 EMA cloud."
        )
        return scanner_read_payload("entry", "Entry", "in 5/12", detail, source_match=good_entry_match, support=support, entry_cloud=entry_cloud)

    if touch_match:
        return scanner_read_payload("wait", "Wait", "5/12 trigger", "Price has cleared MTF resistance, but wait for the 10m 5/12 EMA cloud entry trigger.", source_match=touch_match, entry_cloud=entry_cloud)

    return scanner_read_payload("wait", "Wait", "in 5/12, no trigger", "Price is inside the 10m 5/12 EMA cloud, but no curl or quality 10m bounce trigger is active.", entry_cloud=entry_cloud)


def bearish_scanner_read(
    good_entry_match: dict[str, Any] | None,
    bad_bounce: dict[str, Any] | None,
    touch_match: dict[str, Any] | None,
    entry_cloud: dict[str, Any] | None,
    resistance: dict[str, Any] | None,
    support: dict[str, Any] | None,
) -> dict[str, Any]:
    if support and support.get("direction") == "inside":
        label = short_mtf_label(support.get("label"))
        return scanner_read_payload("wait", "Wait", f"break {label}", "Price is inside an MTF cloud. Treat it as support until price breaks below it.", support=support)

    if support and cloud_distance_pct(support) is not None and cloud_distance_pct(support) <= MTF_RESISTANCE_DISTANCE_PCT:
        label = short_mtf_label(support.get("label"))
        return scanner_read_payload("wait", "Wait", f"break {label}", "Nearest MTF cloud is still underfoot support. A clean move below it makes the read more bearish.", support=support)

    if bad_bounce and not good_entry_match:
        return scanner_read_payload("skip", "Skip", "weak rejection", bad_bounce.get("setup_quality_note") or "The 10m 34/50 rejection is marked low quality.", source_match=bad_bounce)

    if not entry_cloud:
        return scanner_read_payload("wait", "Wait", "need 5/12", "The scanner needs the 10m 5/12 EMA cloud to judge the short entry.")

    if entry_cloud["status"] == "below":
        detail = (
            f"Price is below MTF support and {short_mtf_label(resistance.get('label'))} is overhead resistance, but entry should wait for the 10m 5/12 EMA cloud."
            if resistance
            else "Price is bearish but extended below the 10m 5/12 EMA cloud. Wait for the entry pullback."
        )
        return scanner_read_payload("wait", "Wait", "pullback 5/12", detail, resistance=resistance, entry_cloud=entry_cloud)

    if entry_cloud["status"] == "extended":
        return scanner_read_payload("wait", "Wait", "reject 5/12", "Price is above the 10m 5/12 EMA cloud. Wait for rejection back into the short entry zone.", entry_cloud=entry_cloud)

    if good_entry_match:
        detail = (
            f"{display_match_name(good_entry_match)} with price inside the 10m 5/12 EMA cloud. MTF cloud above is resistance."
            if resistance
            else f"{display_match_name(good_entry_match)} with price inside the 10m 5/12 EMA cloud."
        )
        return scanner_read_payload("entry", "Entry", "in 5/12", detail, source_match=good_entry_match, resistance=resistance, entry_cloud=entry_cloud)

    if touch_match:
        return scanner_read_payload("wait", "Wait", "5/12 trigger", "Price has broken MTF support, but wait for the 10m 5/12 EMA cloud short entry trigger.", source_match=touch_match, entry_cloud=entry_cloud)

    return scanner_read_payload("wait", "Wait", "in 5/12, no trigger", "Price is inside the 10m 5/12 EMA cloud, but no quality 10m rejection trigger is active.", entry_cloud=entry_cloud)


def scanner_read_payload(
    kind: str,
    label: str,
    reason: str,
    detail: str,
    source_match: dict[str, Any] | None = None,
    resistance: dict[str, Any] | None = None,
    support: dict[str, Any] | None = None,
    entry_cloud: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "kind": kind,
        "label": label,
        "reason": reason,
        "detail": detail,
    }
    if source_match:
        payload["source_match_type"] = source_match.get("type")
        payload["source_match_label"] = source_match.get("display_label") or source_match.get("label")
        payload["entry_price"] = source_match.get("entry_price")
        payload["candle_time"] = source_match.get("candle_time")
    if resistance:
        payload["resistance"] = compact_cloud(resistance)
    if support:
        payload["support"] = compact_cloud(support)
    if entry_cloud:
        payload["entry_cloud"] = entry_cloud
    return payload


def entry_cloud_distance(price: float | None, ema_10m: dict[str, float | None]) -> dict[str, Any] | None:
    ema5 = ema_10m.get("5")
    ema12 = ema_10m.get("12")
    if price is None or ema5 is None or ema12 is None or price <= 0:
        return None
    low = min(ema5, ema12)
    high = max(ema5, ema12)
    if low <= price <= high:
        distance = 0
        status = "entry"
    elif price > high:
        distance = price - high
        status = "extended"
    else:
        distance = low - price
        status = "below"
    distance_pct = distance / price * 100
    return {
        "low": round(low, 4),
        "high": round(high, 4),
        "distance": round(distance, 4),
        "distance_pct": round(distance_pct, 2),
        "status": status,
    }


def nearest_mtf_resistance(proximity: dict[str, Any]) -> dict[str, Any] | None:
    candidates = [
        cloud
        for cloud in proximity.get("clouds", [])
        if cloud.get("direction") in {"above", "inside"}
        and cloud_distance_pct(cloud) is not None
        and cloud_distance_pct(cloud) <= MTF_RESISTANCE_DISTANCE_PCT
    ]
    candidates.sort(key=lambda cloud: (cloud_distance_pct(cloud) or 0, cloud.get("label") or ""))
    return candidates[0] if candidates else None


def nearest_mtf_support(proximity: dict[str, Any]) -> dict[str, Any] | None:
    candidates = [
        cloud
        for cloud in proximity.get("clouds", [])
        if cloud.get("direction") in {"below", "inside"} and cloud_distance_pct(cloud) is not None
    ]
    candidates.sort(key=lambda cloud: (cloud_distance_pct(cloud) or 0, cloud.get("label") or ""))
    return candidates[0] if candidates else None


def cloud_distance_pct(cloud: dict[str, Any]) -> float | None:
    if cloud.get("direction") == "inside":
        return 0
    value = cloud.get("distance_pct")
    return float(value) if value is not None else None


def compact_cloud(cloud: dict[str, Any]) -> dict[str, Any]:
    return {
        "label": cloud.get("label"),
        "cloud_low": cloud.get("cloud_low"),
        "cloud_high": cloud.get("cloud_high"),
        "direction": cloud.get("direction"),
        "distance_pct": cloud.get("distance_pct"),
    }


def short_mtf_label(label: Any) -> str:
    return str(label or "").replace("Hourly ", "H ").replace("Daily ", "D ").strip()


def display_match_name(match: dict[str, Any]) -> str:
    if match.get("type") == "long_mtf_5_12_touch":
        return "curl"
    if match.get("type") == "10m_34_50_bounce":
        return "10m bounce"
    return str(match.get("display_label") or match.get("label") or "setup").lower()


def long_mtf_pullback_matches(
    ten_minute_trend: str,
    ten_minute_candles: list[dict[str, Any]],
    ema_10m: dict[str, float | None],
    ema_1h: dict[str, float | None],
    ema_daily: dict[str, float | None],
    risk_amount: float = A_PLUS_PLUS_MAX_RISK,
    fixed_stop_buffer: float = A_PLUS_PLUS_STOP_BUFFER,
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
    stop_cloud_low = min(source["cloud_low"] for source in mtf_sources)
    stop_cloud_high = max(source["cloud_high"] for source in mtf_sources)
    risk_plan = fixed_stop_risk_plan(
        entry=entry_price,
        stop=stop_cloud_low - fixed_stop_buffer,
        max_risk=risk_amount,
        stop_buffer=fixed_stop_buffer,
        stop_mode="curl-mtf-cloud",
    )
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
            "stop_cloud_low": round(stop_cloud_low, 4),
            "stop_cloud_high": round(stop_cloud_high, 4),
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
            **({"risk_plan": risk_plan} if risk_plan else {}),
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
    risk_amount: float = A_PLUS_PLUS_MAX_RISK,
    fixed_stop_buffer: float = A_PLUS_PLUS_STOP_BUFFER,
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

    if candle_close > cloud_high and (previous_close is None or candle_close > previous_close):
        trend = "Bullish"
        trade_action = "Long"
        direction = "bounce_above_10m_34_50"
        setup_word = "Bounce"
        quality_clouds = nearby_mtf_clouds(candle_close, ema_1h or {}, ema_daily or {}, side="overhead")
        setup_quality_note = (
            f"Overhead cloud nearby: {', '.join(cloud['label'] for cloud in quality_clouds)}"
            if quality_clouds
            else "Clear room above 10m 34/50"
        )
        stop = cloud_low - fixed_stop_buffer
    elif candle_close < cloud_low and (previous_close is None or candle_close < previous_close):
        trend = "Bearish"
        trade_action = "Short"
        direction = "reject_below_10m_34_50"
        setup_word = "Rejection"
        quality_clouds = nearby_mtf_clouds(candle_close, ema_1h or {}, ema_daily or {}, side="underfoot")
        setup_quality_note = (
            f"Underfoot cloud nearby: {', '.join(cloud['label'] for cloud in quality_clouds)}"
            if quality_clouds
            else "Clear room below 10m 34/50"
        )
        stop = cloud_high + fixed_stop_buffer
    else:
        return []

    candle_time = candle_time_key(candle)
    setup_quality = "bad" if quality_clouds else "good"
    setup_quality_label = "Bad" if setup_quality == "bad" else "Good"
    risk_plan = fixed_stop_risk_plan(
        entry=candle_close,
        stop=stop,
        max_risk=risk_amount,
        stop_buffer=fixed_stop_buffer,
        stop_mode="10m-34-50-cloud",
    )
    return [
        {
            "label": "10m 34/50 Bounce",
            "display_label": f"{setup_quality_label} 34/50 {setup_word}",
            "timeframe": "10m",
            "mtf_label": "10m 34/50",
            "cloud_label": "10m 34/50",
            "setup_quality": setup_quality,
            "setup_quality_note": setup_quality_note,
            "overhead_clouds": quality_clouds if trend == "Bullish" else [],
            "underfoot_clouds": quality_clouds if trend == "Bearish" else [],
            "stop_cloud_low": round(cloud_low, 4),
            "stop_cloud_high": round(cloud_high, 4),
            "cloud_low": round(cloud_low, 4),
            "cloud_high": round(cloud_high, 4),
            "candle_low": round(candle_low, 4),
            "candle_high": round(candle_high, 4),
            "candle_close": round(candle_close, 4),
            "entry_price": round(candle_close, 4),
            "candle_time": candle_time,
            "type": "10m_34_50_bounce",
            "status": "confirmed",
            "direction": direction,
            "trend": trend,
            "trade_action": trade_action,
            **({"risk_plan": risk_plan} if risk_plan else {}),
        }
    ]


def nearby_overhead_mtf_clouds(
    entry_price: float,
    ema_1h: dict[str, float | None],
    ema_daily: dict[str, float | None],
) -> list[dict[str, Any]]:
    return nearby_mtf_clouds(entry_price, ema_1h, ema_daily, side="overhead")


def nearby_mtf_clouds(
    entry_price: float,
    ema_1h: dict[str, float | None],
    ema_daily: dict[str, float | None],
    side: str,
) -> list[dict[str, Any]]:
    if entry_price <= 0:
        return []

    nearby_clouds = []
    for check in LONG_MTF_CLOUDS:
        ema_set = ema_1h if check["source"] == "hourly" else ema_daily
        first = ema_set.get(check["keys"][0])
        second = ema_set.get(check["keys"][1])
        if first is None or second is None:
            continue
        cloud_low = min(first, second)
        cloud_high = max(first, second)
        if side == "overhead" and cloud_high < entry_price:
            continue
        if side == "underfoot" and cloud_low > entry_price:
            continue
        distance = max(cloud_low - entry_price, 0) if side == "overhead" else max(entry_price - cloud_high, 0)
        distance_ratio = distance / entry_price
        if distance_ratio > BOUNCE_OVERHEAD_CLOUD_BUFFER:
            continue
        nearby_clouds.append(
            {
                "label": check["label"],
                "cloud_low": round(cloud_low, 4),
                "cloud_high": round(cloud_high, 4),
                "distance_pct": round(distance_ratio * 100, 2),
            }
        )
    return nearby_clouds


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
