from datetime import datetime, time, timezone
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
A_PLUS_PLUS_MAX_RISK = 100
A_PLUS_PLUS_STOP_BUFFER = 1
MTF_CLOUD_STOP_BUFFER = 3
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
        ten_minute_ema = ema_values(ten_minute_candles, [5, 9, 12, 34, 40, 50])
        ten_minute_cloud = ema_cloud_context(ten_minute_candles, 5, 12)
        ten_minute_trend = cloud_status(ten_minute_ema, ["5", "12"], ["34", "50"])
        latest_10m_candle = latest_ten_minute_candle(ten_minute_candles)
        latest_10m_close = latest_10m_candle.get("close") if latest_10m_candle else None
        candle_price = latest_ten_minute_price(ten_minute_candles, price)
        quotes.append(
            {
                "symbol": symbol,
                "sector": SYMBOL_SECTORS.get(symbol, "Other"),
                "price": price,
                "scanner_price": candle_price,
                "scanner_price_source": "latest_10m_candle_close" if latest_10m_close is not None else "snapshot",
                "latest_10m_close": latest_10m_close,
                "latest_10m_time": latest_10m_candle.get("time") if latest_10m_candle else None,
                "change": snapshot_change(snapshot_map.get(symbol)),
                "change_ratio": snapshot_change_ratio(snapshot_map.get(symbol)),
                "previous_day": previous_daily_range(daily_candles),
                "ema_10m": ten_minute_ema,
                "ema_10m_cloud": ten_minute_cloud,
                "ema_1h": ema_1h,
                "ema_daily": ema_daily,
                "structure_10m": market_structure(ten_minute_candles),
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


def previous_daily_range(candles: list[dict[str, Any]]) -> dict[str, Any] | None:
    today = datetime.now(MARKET_TIMEZONE).date().isoformat()
    completed = [
        candle for candle in candles
        if candle.get("session_date") and candle.get("session_date") < today
        and candle.get("high") is not None and candle.get("low") is not None
    ]
    if not completed:
        completed = [
            candle for candle in candles
            if candle.get("high") is not None and candle.get("low") is not None
        ][:-1]
    if not completed:
        return None
    candle = completed[-1]
    return {
        "date": candle.get("session_date"),
        "high": round(candle["high"], 4),
        "low": round(candle["low"], 4),
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


def ema_cloud_context(candles: list[dict[str, Any]], fast_period: int = 5, slow_period: int = 12) -> dict[str, Any]:
    confirmed = [candle for candle in candles if is_complete_ten_minute_candle(candle) and candle.get("close") is not None]
    if len(confirmed) < slow_period:
        return {"status": "Unknown", "bias": "Wait", "setup": "Unknown"}
    latest_session = confirmed[-1].get("session_date")
    if latest_session:
        session_candles = [candle for candle in confirmed if candle.get("session_date") == latest_session]
        if len(session_candles) >= slow_period:
            confirmed = session_candles
    closes = [float(candle["close"]) for candle in confirmed]
    fast_values = chart_ema(closes, fast_period)
    slow_values = chart_ema(closes, slow_period)

    def position(index: int) -> dict[str, Any]:
        fast = fast_values[index]
        slow = slow_values[index]
        low = min(fast, slow)
        high = max(fast, slow)
        close = closes[index]
        if close > high:
            status = "Above"
        elif close < low:
            status = "Below"
        else:
            status = "Inside"
        return {
            "status": status,
            "close": round(close, 4),
            "fast": round(fast, 4),
            "slow": round(slow, 4),
            "low": round(low, 4),
            "high": round(high, 4),
            "time": confirmed[index].get("time") or confirmed[index].get("sort_time") or confirmed[index].get("timestamp"),
        }

    current = position(-1)
    previous = position(-2) if len(confirmed) >= 2 else {"status": "Unknown"}
    setup = current["status"]
    bias = "Wait"
    if current["status"] == "Above":
        setup = "Above 5/12"
        bias = "Long"
    elif current["status"] == "Below":
        setup = "Below 5/12"
        bias = "Short"
    elif previous.get("status") == "Below":
        setup = "Curl Up"
        bias = "Long"
    elif previous.get("status") == "Above":
        setup = "Break Curl Down"
        bias = "Short"
    elif current["status"] == "Inside":
        setup = "Curl Watch"

    return {
        **current,
        "previous_status": previous.get("status", "Unknown"),
        "previous_close": previous.get("close"),
        "previous_time": previous.get("time"),
        "setup": setup,
        "bias": bias,
    }


def market_structure(candles: list[dict[str, Any]], lookback: int = 6) -> dict[str, Any]:
    confirmed = [candle for candle in candles if is_complete_ten_minute_candle(candle)]
    if len(confirmed) < 2:
        return {"status": "Unknown"}
    latest_session = confirmed[-1].get("session_date")
    if latest_session:
        session_candles = [candle for candle in confirmed if candle.get("session_date") == latest_session]
        if len(session_candles) >= 2:
            confirmed = session_candles
    latest_range: dict[str, Any] | None = None
    breaks: list[dict[str, Any]] = []
    for index in range(1, len(confirmed)):
        current = confirmed[index]
        previous = confirmed[max(0, index - lookback):index]
        highs = [candle.get("high") for candle in previous if candle.get("high") is not None]
        lows = [candle.get("low") for candle in previous if candle.get("low") is not None]
        broader_previous = confirmed[:index]
        broader_highs = [candle.get("high") for candle in broader_previous if candle.get("high") is not None]
        broader_lows = [candle.get("low") for candle in broader_previous if candle.get("low") is not None]
        close = current.get("close")
        if close is None or not highs or not lows:
            continue
        structure_high = max(highs)
        structure_low = min(lows)
        broader_high = max(broader_highs) if broader_highs else structure_high
        broader_low = min(broader_lows) if broader_lows else structure_low
        latest_range = {
            "high": round(structure_high, 4),
            "low": round(structure_low, 4),
            "broader_high": round(broader_high, 4),
            "broader_low": round(broader_low, 4),
            "close": round(close, 4),
            "time": current.get("time") or current.get("sort_time") or current.get("timestamp"),
            "lookback": len(previous),
        }
        if close > structure_high:
            breaks.append({
                **latest_range,
                "direction": "Bullish",
                "status": "Bullish BOS",
                "broad_break": close > broader_high,
            })
        elif close < structure_low:
            breaks.append({
                **latest_range,
                "direction": "Bearish",
                "status": "Bearish BOS",
                "broad_break": close < broader_low,
            })
    if not latest_range:
        return {"status": "Unknown"}
    if not breaks:
        return {**latest_range, "status": "Chop"}

    latest_break = breaks[-1]
    same_direction_count = 0
    for structure_break in reversed(breaks):
        if structure_break["direction"] != latest_break["direction"]:
            break
        same_direction_count += 1

    current_close = latest_range.get("close")
    still_holding_single_break = (
        latest_break["direction"] == "Bullish"
        and current_close is not None
        and current_close > latest_break["high"]
    ) or (
        latest_break["direction"] == "Bearish"
        and current_close is not None
        and current_close < latest_break["low"]
    )
    if latest_break.get("broad_break") and (same_direction_count >= 2 or still_holding_single_break):
        return {
            **latest_range,
            "status": latest_break["status"],
            "break_count": same_direction_count,
            "last_break_time": latest_break.get("time"),
            "last_break_high": latest_break.get("high"),
            "last_break_low": latest_break.get("low"),
        }
    return {
        **latest_range,
        "status": "Chop",
        "break_count": same_direction_count,
        "last_break_time": latest_break.get("time"),
        "last_break_status": latest_break["status"],
    }


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
) -> list[dict[str, Any]]:
    if ten_minute_trend == "Chop":
        return []
    candle = latest_ten_minute_candle(ten_minute_candles)
    if not candle:
        return []
    candle_complete = is_complete_ten_minute_candle(candle)
    candle_time = candle.get("time") or candle.get("sort_time") or candle.get("timestamp")
    previous_candle = previous_ten_minute_candle(ten_minute_candles)
    previous_price = previous_candle.get("close") if previous_candle else None
    candle_high = candle.get("high")
    candle_low = candle.get("low")
    matches = mtf_matches(
        price,
        ten_minute_trend,
        ema_10m,
        ema_1h,
        ema_daily,
        previous_price=previous_price,
        current_high=candle_high,
        current_low=candle_low,
        candle_complete=candle_complete,
        risk_amount=risk_amount,
    )
    matches.extend(
        ema_cloud_bounce_matches(
            ten_minute_candles,
            ema_10m,
            ema_1h,
            ema_daily,
            daily_candles=daily_candles,
            previous_price=previous_price,
            risk_amount=risk_amount,
            stop_mode=stop_mode,
            fixed_stop_buffer=fixed_stop_buffer,
        )
    )
    matches.extend(
        nine_ema_touch_matches(
            ten_minute_candles,
            ema_10m,
            risk_amount=risk_amount,
        )
    )
    matches.extend(
        forty_ema_touch_matches(
            ten_minute_candles,
            ema_10m,
            risk_amount=risk_amount,
        )
    )
    visible_matches = []
    for match in matches:
        if candle_time is not None:
            match.setdefault("candle_time", candle_time)
        match.setdefault("status", "confirmed")
        visible_matches.append(match)
    return dedupe_mtf_signal_matches(visible_matches)


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
        family = ":".join(
            [
                str(match.get("trade_action") or "watch"),
                mtf_signal_cloud_family(match),
                str(match.get("candle_time") or ""),
            ]
        )
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


def forty_ema_touch_matches(
    ten_minute_candles: list[dict[str, Any]],
    ema_10m: dict[str, float | None],
    risk_amount: float = A_PLUS_PLUS_MAX_RISK,
) -> list[dict[str, Any]]:
    candle = latest_ten_minute_candle(ten_minute_candles)
    if not candle:
        return []
    candle_time = candle.get("time") or candle.get("sort_time") or candle.get("timestamp")

    ema40 = ema_10m.get("40")
    ema5 = ema_10m.get("5")
    ema12 = ema_10m.get("12")
    ema34 = ema_10m.get("34")
    ema50 = ema_10m.get("50")
    if ema40 is None or ema5 is None or ema12 is None or ema34 is None or ema50 is None:
        return []

    ten_minute_trend = cloud_status(ema_10m, ["5", "12"], ["34", "50"])
    if ten_minute_trend != "Bullish":
        return []

    low = candle.get("low")
    high = candle.get("high")
    close = candle.get("close")
    if low is None or close is None:
        return []
    high = high if high is not None else max(value for value in (candle.get("open"), close, low) if value is not None)
    if not (low <= ema40 <= high):
        return []

    slow_cloud_low = min(ema34, ema50)
    slow_cloud_high = max(ema34, ema50)
    stop_buffer = A_PLUS_PLUS_STOP_BUFFER
    risk_plan = fixed_stop_risk_plan(
        entry=ema40,
        stop=slow_cloud_low - stop_buffer,
        max_risk=risk_amount,
        stop_buffer=stop_buffer,
        stop_mode="10m-34-50-cloud",
    )
    if not risk_plan:
        return []

    return [
        {
            "label": "10m 40 EMA touch",
            "display_label": "10m 40 EMA touch",
            "timeframe": "10m",
            "ema40": round(ema40, 4),
            "cloud_low": round(min(ema5, ema12), 4),
            "cloud_high": round(max(ema5, ema12), 4),
            "stop_cloud_low": round(slow_cloud_low, 4),
            "stop_cloud_high": round(slow_cloud_high, 4),
            "candle_low": round(low, 4),
            "candle_high": round(high, 4),
            "candle_close": round(close, 4),
            "entry_price": round(ema40, 4),
            "candle_time": candle_time,
            "type": "10m_40ema_touch",
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
