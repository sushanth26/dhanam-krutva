"""MTF cloud bounce / reject alerts (ported from Cloud Desk).

Setup: price comes back to a higher-timeframe cloud (1H 34/50, daily 20/21, daily 50/55) and holds.
  Bounce (long): most of the last 6 regular-session 10-min bars closed above the cloud, a candle
  actually reached the cloud (0.05% slack) on this bar or the 2 before it, and this bar closes
  back above the cloud as a green candle. Reject (short) mirrors it.
Trade plan (Ripster management, confirmed on 2020-2026 in-play backtests in Stock-Intel
backtest/evolve.py): stop just past the alert candle and the one before it (0.1 x 10-min ATR
pad, at least 0.15% from entry); skip if that stop is over 3% away. Exit when a 10-min candle
closes through the 10-min 5/12 cloud (below it for a long, above it for a short), or at the stop.
PB: optional pullback limit at the cloud edge the candle bounced off (Stock-Intel
backtest/early_bounce.py: better R on gap days but fills only ~40%, missing the runners).
Watch: during the first 10-min candle (9:30-9:40) a heads-up, not a trade, the moment the live
price tags a cloud and is back above (below) it; the backtest showed these in-candle triggers
are mostly fakeouts, so the trade still waits for the 10-min close.
Only completed 10-min bars from 9:40 to 15:00 ET. A separate premarket pass (its own bars,
4:00-9:30 ET) alerts from 8:30 to the open, labelled "PM"; the regular-session pass ignores it
(PM alerts get no exit tracking). S1/S2 and R1/R2: nearest support / resistance levels around the entry, from
30-min SR channels (LonesomeTheBlue settings), prior-day high / low / close, premarket high / low
and daily swing highs / lows.

Clouds are computed like the rest of this app (and TradingView with extended hours): the 1H and
daily EMAs as of each 10-min bar's close, with the still-open hourly / daily bar taking that close.
"""

from __future__ import annotations

import os
from datetime import datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
RTH_OPEN = time(9, 30)
RTH_CLOSE = time(16, 0)
FIRST_ALERT = time(9, 40)
LAST_ALERT = time(15, 0)
PREMARKET_OPEN = time(4, 0)
PREMARKET_FIRST_ALERT = time(8, 30)
TOUCH_BARS = 3
TOUCH_SLACK = 0.0005
STOP_PAD_ATR = 0.1
REPEAT_MINUTES = 60
WATCH_LAST_END = time(9, 40)  # watch pings only while the first 10-min candle is forming
# Premarket alerts are off unless BOUNCE_PREMARKET_ENABLED=true: the trade plan was only
# backtested on regular-session alerts (9:40 on), and premarket ones have no exit tracking.
PREMARKET_ENABLED = os.getenv("BOUNCE_PREMARKET_ENABLED", "").strip().lower() in ("1", "true", "yes", "on")
MIN_RISK = 0.0015  # stop at least 0.15% from entry
MAX_RISK = 0.03    # skip alerts whose stop would be more than 3% away
CLOUDS = (("1H 34/50", "h", 34, 50), ("D 20/21", "d", 20, 21), ("D 50/55", "d", 50, 55))


def _dt(candle: dict[str, Any]) -> datetime | None:
    raw = candle.get("sort_time") or candle.get("time")
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.replace(tzinfo=ET) if parsed.tzinfo is None else parsed.astimezone(ET)


class _Ema:
    def __init__(self, n: int):
        self.a = 2 / (n + 1)
        self.v: float | None = None
        self.count = 0

    def update(self, x: float) -> None:
        self.v = x if self.v is None else self.v + self.a * (x - self.v)
        self.count += 1

    def peek(self, x: float) -> float | None:
        """Value if the still-open bar closed at x."""
        return x if self.v is None else self.v + self.a * (x - self.v)


def _completed_series(candles: list[dict[str, Any]], length: timedelta, periods: tuple[int, ...]):
    """[(bar end, {period: ema state copy})] after each completed bar."""
    emas = {n: _Ema(n) for n in periods}
    out = []
    for c in candles:
        start = _dt(c)
        if start is None or c.get("close") is None:
            continue
        for e in emas.values():
            e.update(float(c["close"]))
        out.append((start + length, {n: (e.v, e.count) for n, e in emas.items()}))
    return out


def _state_at(series, end: datetime):
    state = None
    for bar_end, s in series:
        if bar_end > end:
            break
        state = s
    return state


def _peek(state, n: int, price: float, min_bars: int) -> float | None:
    if not state or state[n][0] is None or state[n][1] < min_bars:
        return None
    v, _ = state[n]
    a = 2 / (n + 1)
    return v + a * (price - v)


def _daily_series(daily: list[dict[str, Any]]):
    """[(session date, {period: (ema, count)}, high, low)] after each completed daily bar."""
    emas = {n: _Ema(n) for n in (20, 21, 50, 55)}
    out = []
    for c in daily:
        start = _dt(c)
        if start is None or c.get("close") is None:
            continue
        for e in emas.values():
            e.update(float(c["close"]))
        # daily stamps may be midnight UTC (20:00 ET the evening before) or the session itself
        day = (start + timedelta(days=1)).date() if start.hour >= 18 else start.date()
        out.append((day, {n: (e.v, e.count) for n, e in emas.items()}, c["high"], c["low"], c["close"]))
    return out


# ------------------------------ SR channels ------------------------------ #

def bars_30m(m5: list[dict[str, Any]]) -> list[tuple[datetime, float, float]]:
    """Clock-aligned 30-min bars (end time, high, low), 04:00-20:00 ET."""
    buckets: dict[datetime, list[float]] = {}
    for c in m5:
        t = _dt(c)
        if t is None or not (time(4, 0) <= t.time() < time(20, 0)):
            continue
        end = t.replace(minute=(t.minute // 30) * 30, second=0, microsecond=0) + timedelta(minutes=30)
        b = buckets.get(end)
        if b is None:
            buckets[end] = [float(c["high"]), float(c["low"])]
        else:
            b[0], b[1] = max(b[0], float(c["high"])), min(b[1], float(c["low"]))
    return [(end, h, l) for end, (h, l) in sorted(buckets.items())]


def sr_channels(b30: list[tuple], end: int, prd: int = 10, width_pct: float = 2.0, loopback: int = 290,
                maxnum: int = 6, minstrength: int = 2) -> list[tuple[float, float, int]]:
    """Support/resistance channels as of 30-min bar index `end`, after LonesomeTheBlue's
    "Support Resistance Channels" (pivot 10, max width 2%, min strength 2, 6 channels)."""
    start = max(0, end - loopback)
    if end - start < 2 * prd + 1:
        return []
    highs = [x[1] for x in b30[: end + 1]]
    lows = [x[2] for x in b30[: end + 1]]
    piv = []
    for k in range(max(start, prd), end - prd + 1):
        if highs[k] >= max(highs[k - prd: k + prd + 1]):
            piv.append(highs[k])
        if lows[k] <= min(lows[k - prd: k + prd + 1]):
            piv.append(lows[k])
    if not piv:
        return []
    r0 = max(0, end - 299)
    cw = (max(highs[r0: end + 1]) - min(lows[r0: end + 1])) * width_pct / 100
    chans = []
    for x in piv:
        lo = hi = x
        n = 0
        for y in piv:
            w = (hi - y) if y <= hi else (y - lo)
            if w <= cw:
                lo, hi = min(lo, y), max(hi, y)
                n += 20
        touches = sum(1 for k in range(start, end + 1) if lo <= highs[k] <= hi or lo <= lows[k] <= hi)
        chans.append((lo, hi, n + touches))
    out: list[tuple[float, float, int]] = []
    for lo, hi, st in sorted(chans, key=lambda c: -c[2]):
        if st < minstrength * 20 or len(out) >= maxnum:
            continue
        if any(not (hi < a or lo > b) for a, b, _ in out):
            continue
        out.append((lo, hi, st))
    return out


def levels_around(entry: float, chans: list, extra: list[float]) -> dict[str, float | None]:
    """S1/S2 below the entry and R1/R2 above it: SR channel near edges plus extra levels."""
    sup = [hi for lo, hi, _ in chans if hi < entry] + [x for x in extra if x is not None and x < entry]
    res = [lo for lo, hi, _ in chans if lo > entry] + [x for x in extra if x is not None and x > entry]

    def pick(values: list[float], reverse: bool) -> list[float]:
        out: list[float] = []
        for v in sorted(values, reverse=reverse):
            if all(abs(v - o) > entry * 0.001 for o in out):
                out.append(v)
        return out[:2] + [None] * (2 - len(out[:2]))

    s, r = pick(sup, True), pick(res, False)
    return {"s1": s[0], "s2": s[1], "r1": r[0], "r2": r[1]}


def daily_swings(days: list[tuple]) -> list[float]:
    """Daily swing highs / lows (5-bar pivots) from (date, emas, high, low, close) rows."""
    out = []
    for k in range(2, len(days) - 2):
        win = days[k - 2: k + 3]
        if days[k][2] >= max(d[2] for d in win):
            out.append(days[k][2])
        if days[k][3] <= min(d[3] for d in win):
            out.append(days[k][3])
    return out


# ------------------------------- detection ------------------------------- #

def trade_exit(bars: list[dict[str, Any]], i: int, side: str, entry: float, stop: float) -> dict[str, Any] | None:
    """How the alert's trade ends, from completed bars after it: stop hit, a 10-min close through
    the 5/12 cloud, or the session close. None while it's still open."""
    session = bars[i]["t"].date()
    risk = abs(entry - stop)
    sign = 1 if side == "long" else -1
    for j in range(i + 1, len(bars)):
        b = bars[j]
        if b["t"].date() != session:
            break
        hit = b["l"] <= stop if side == "long" else b["h"] >= stop
        if hit:
            px = min(b["o"], stop) if side == "long" else max(b["o"], stop)
            reason, label = "stop", "Stopped"
        elif (b["c"] < min(b["e5"], b["e12"])) if side == "long" else (b["c"] > max(b["e5"], b["e12"])):
            px, reason, label = b["c"], "512", "5/12 lost"
        elif b["end"].time() >= RTH_CLOSE:
            px, reason, label = b["c"], "close", "Close"
        else:
            continue
        return {
            "reason": reason,
            "label": label,
            "time": b["t"].strftime("%H:%M"),
            "bar_close": b["end"].isoformat(),
            "price": round(px, 2),
            "r": round(sign * (px - entry) / risk, 2) if risk else 0.0,
        }
    return None


def bounce_alerts(symbol: str, m5: list[dict[str, Any]], ten: list[dict[str, Any]],
                  h1: list[dict[str, Any]], daily: list[dict[str, Any]],
                  now: datetime | None = None, premarket: bool | None = None) -> list[dict[str, Any]]:
    """Bounce / reject alerts for the latest session in `ten` (ETH 10-min bars): regular session,
    plus premarket when enabled."""
    now = (now or datetime.now(ET)).astimezone(ET)
    if premarket is None:
        premarket = PREMARKET_ENABLED
    premarket = _bounce_alerts(symbol, m5, ten, h1, daily, now, (PREMARKET_OPEN, RTH_OPEN),
                               (PREMARKET_FIRST_ALERT, RTH_OPEN), "PM ") if premarket else []
    regular = _bounce_alerts(symbol, m5, ten, h1, daily, now, (RTH_OPEN, RTH_CLOSE), (FIRST_ALERT, LAST_ALERT), "")
    return premarket + regular


def watch_alerts(symbol: str, m5: list[dict[str, Any]], ten: list[dict[str, Any]],
                 h1: list[dict[str, Any]], daily: list[dict[str, Any]], price: float | None = None,
                 now: datetime | None = None) -> list[dict[str, Any]]:
    """Heads-up while the first regular-session 10-min candle is still forming: it tagged an MTF
    cloud and the live price is back above (below) it. Not a trade signal."""
    now = (now or datetime.now(ET)).astimezone(ET)
    if not (RTH_OPEN <= now.time() < WATCH_LAST_END):
        return []
    return _bounce_alerts(symbol, m5, ten, h1, daily, now, (RTH_OPEN, RTH_CLOSE), (FIRST_ALERT, WATCH_LAST_END),
                          "Watch ", live_price=price)


def _bounce_alerts(symbol: str, m5: list[dict[str, Any]], ten: list[dict[str, Any]],
                   h1: list[dict[str, Any]], daily: list[dict[str, Any]], now: datetime,
                   bar_window: tuple[time, time], alert_window: tuple[time, time],
                   label: str, live_price: float | None = None) -> list[dict[str, Any]]:
    """One pass: bars inside `bar_window` (start inclusive), alerts on bars closing inside `alert_window`.
    Watch pass (label "Watch "): the still-forming candle is included, with the live price as its close."""
    watch = label == "Watch "
    bars = []
    for c in ten:
        t = _dt(c)
        if t is None or c.get("close") is None:
            continue
        end = t + timedelta(minutes=10)
        forming = t <= now < end
        if watch and forming:
            pass  # the candle being watched
        elif end > now or (c.get("source_count") or 2) < 2:
            continue  # completed bars only
        if bar_window[0] <= t.time() < bar_window[1]:
            bars.append({"t": t, "end": end, "o": float(c["open"]), "h": float(c["high"]),
                         "l": float(c["low"]), "c": float(c["close"]), "forming": forming})
    if watch:
        if not bars or not bars[-1]["forming"]:
            return []
        if live_price:
            b = bars[-1]
            b["c"] = float(live_price)
            b["h"], b["l"] = max(b["h"], b["c"]), min(b["l"], b["c"])
    if len(bars) < 4:
        return []
    session = bars[-1]["t"].date()

    h_series = _completed_series(h1, timedelta(hours=1), (34, 50))
    d_series = _daily_series(daily)
    prev_daily = [d for d in d_series if d[0] < session]
    d_state = prev_daily[-1][1] if prev_daily else None
    pdh = prev_daily[-1][2] if prev_daily else None
    pdl = prev_daily[-1][3] if prev_daily else None
    pdc = prev_daily[-1][4] if prev_daily else None
    swings = daily_swings(prev_daily[-120:])
    pre = [c for c in m5 if (t := _dt(c)) and t.date() == session and time(4, 0) <= t.time() < RTH_OPEN]
    pmh = max((float(c["high"]) for c in pre), default=None)
    pml = min((float(c["low"]) for c in pre), default=None)

    # attach clouds, 10-min ATR and the 10-min 5/12 cloud to every bar
    atr, prev_c = None, None
    e5, e12 = _Ema(5), _Ema(12)
    for b in bars:
        e5.update(b["c"])
        e12.update(b["c"])
        b["e5"], b["e12"] = e5.v, e12.v
        tr = b["h"] - b["l"] if prev_c is None else max(b["h"] - b["l"], abs(b["h"] - prev_c), abs(b["l"] - prev_c))
        atr = tr if atr is None else (atr * 13 + tr) / 14
        b["atr"], prev_c = atr, b["c"]
        hs = _state_at(h_series, b["end"])
        ds = d_state if b["t"].date() == session else next(
            (d[1] for d in reversed(d_series) if d[0] < b["t"].date()), None)
        b["clouds"] = {}
        for name, kind, fast, slow in CLOUDS:
            state, min_bars = (hs, 50) if kind == "h" else (ds, 55)
            a, z = _peek(state, fast, b["c"], min_bars), _peek(state, slow, b["c"], min_bars)
            if a is not None and z is not None:
                b["clouds"][name] = (min(a, z), max(a, z))

    b30 = bars_30m(m5)
    b30_ends = [x[0] for x in b30]
    out: list[dict[str, Any]] = []
    last_fired: dict[tuple[str, str], datetime] = {}
    for i, b in enumerate(bars):
        if b["t"].date() != session or not (alert_window[0] <= b["end"].time() <= alert_window[1]):
            continue
        if watch and not b["forming"]:
            continue
        prior = [x for x in bars[max(0, i - 6): i] if x["t"].date() == session]
        if len(prior) < 3:
            prior = bars[max(0, i - 6): i]  # first bars: include yesterday's last bars
            if len(prior) < 3:
                continue
        recent = [x for x in bars[max(0, i - TOUCH_BARS + 1): i + 1] if x["t"].date() == session] or [b]
        for side in ("long", "short"):
            for name, *_ in CLOUDS:
                z = b["clouds"].get(name)
                if z is None or any(name not in x["clouds"] for x in prior):
                    continue
                lo, hi = z
                if side == "long":
                    tol = hi * TOUCH_SLACK
                    came_from = sum(x["c"] > x["clouds"][name][1] for x in prior) * 2 >= len(prior)
                    ok = came_from and min(x["l"] for x in recent) <= hi + tol and b["c"] > hi and (watch or b["c"] > b["o"])
                else:
                    tol = lo * TOUCH_SLACK
                    came_from = sum(x["c"] < x["clouds"][name][0] for x in prior) * 2 >= len(prior)
                    ok = came_from and max(x["h"] for x in recent) >= lo - tol and b["c"] < lo and (watch or b["c"] < b["o"])
                if not ok:
                    continue
                prev = last_fired.get((name, side))
                last_fired[(name, side)] = b["end"]
                if prev and (b["end"] - prev) < timedelta(minutes=REPEAT_MINUTES):
                    break  # same cloud + side again within the hour: not a new alert
                if watch:
                    out.append({
                        "id": f"{symbol}|{b['t'].isoformat()}|{side}|{name}|watch",
                        "symbol": symbol,
                        "side": side,
                        "cloud": name,
                        "alert": f"Watch {'Bounce' if side == 'long' else 'Reject'} {name}",
                        "watch": True,
                        "time": b["t"].strftime("%H:%M"),
                        "bar_start": b["t"].isoformat(),
                        "price": round(b["c"], 2),
                        "pb": round(hi if side == "long" else lo, 2),
                    })
                    break
                pad = STOP_PAD_ATR * b["atr"]
                pb = bars[i - 1] if i else b
                if side == "long":
                    stop = min(b["l"], pb["l"]) - pad
                    stop = min(stop, b["c"] * (1 - MIN_RISK))
                else:
                    stop = max(b["h"], pb["h"]) + pad
                    stop = max(stop, b["c"] * (1 + MIN_RISK))
                if abs(b["c"] - stop) > MAX_RISK * b["c"]:
                    break  # entry too far from a sensible stop: not worth taking
                k = sum(1 for e in b30_ends if e <= b["end"]) - 1
                chans = sr_channels(b30, k) if k >= 0 else []
                out.append({
                    "id": f"{symbol}|{b['end'].isoformat()}|{side}|{name}",
                    "symbol": symbol,
                    "side": side,
                    "cloud": name,
                    "alert": f"{label}{'Bounce' if side == 'long' else 'Reject'} {name}",
                    "premarket": bool(label),
                    "exit": None if label else trade_exit(bars, i, side, b["c"], stop),
                    "time": b["t"].strftime("%H:%M"),  # candle open, ET (how charts label it)
                    "bar_start": b["t"].isoformat(),
                    "bar_close": b["end"].isoformat(),
                    "entry": round(b["c"], 2),
                    "stop": round(stop, 2),
                    "pb": round(hi if side == "long" else lo, 2),  # optional pullback limit at the cloud edge
                    **{k2: (round(v, 2) if v is not None else None)
                       for k2, v in levels_around(b["c"], chans, [pdh, pdl, pdc, pmh, pml, *swings]).items()},
                })
                break  # one cloud per bar per side
    return out
