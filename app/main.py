from datetime import datetime, timezone
import base64
import secrets
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from webull.data.common.category import Category
from webull.data.common.timespan import Timespan

from app.config import get_settings
from app.strategy import WATCHLIST, find_snapshot_list, normalize_bars, run_dry_run, snapshot_price
from app.tradingview_mcp import TradingViewMcpError, analyze_symbol
from app.webull_service import WebullConfigurationError, WebullService


LIVE_WATCHLIST = [
    "BE", "CRDO", "AAOI", "SNDK", "MU", "GLW", "MRVL", "COHR", "RKLB",
    "ASTS", "AMD", "ARM", "AVGO", "DELL", "INTC", "APP", "LLY",
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
}

app = FastAPI(title="Dhanam Krutva Webull Dashboard")
app.mount("/static", StaticFiles(directory="app/static"), name="static")


class BuyRequest(BaseModel):
    account_id: str = Field(min_length=1)
    symbol: str = Field(min_length=1, max_length=12)


def service() -> WebullService:
    return WebullService(get_settings())


@app.middleware("http")
async def require_app_auth(request: Request, call_next):
    settings = get_settings()
    if not settings.auth_enabled or request.url.path == "/health":
        return await call_next(request)

    if is_authorized(request, settings.app_username, settings.app_password or ""):
        return await call_next(request)

    return JSONResponse(
        {"detail": "Authentication required."},
        status_code=401,
        headers={"WWW-Authenticate": 'Basic realm="Dhanam Krutva"'},
    )


@app.get("/")
def index() -> FileResponse:
    return FileResponse("app/static/index.html")


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/api/status")
def status():
    return service().status()


@app.get("/api/accounts")
def accounts():
    try:
        return service().account_list()
    except WebullConfigurationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/account/{account_id}/balance")
def balance(account_id: str):
    try:
        return service().account_balance(account_id)
    except WebullConfigurationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/account/{account_id}/positions")
def positions(account_id: str):
    try:
        return service().account_positions(account_id)
    except WebullConfigurationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/account/{account_id}/orders")
def orders(account_id: str, page_size: int = Query(default=10, ge=1, le=50), days: int = Query(default=30, ge=1, le=365)):
    try:
        return service().order_history(account_id, page_size=page_size, days=days)
    except WebullConfigurationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/snapshot")
def snapshot(account_id: str | None = Query(default=None)):
    try:
        return service().snapshot(account_id)
    except WebullConfigurationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/webull/quote")
def webull_quote(symbol: str = Query(default="AAPL", min_length=1, max_length=16)):
    try:
        return service().live_quote(symbol=symbol, category=Category.US_STOCK.name)
    except WebullConfigurationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/webull/live-prices")
def webull_live_prices(symbols: str = Query(default=",".join(LIVE_WATCHLIST))):
    selected_symbols = parse_symbols(symbols)
    webull = service()
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
        quotes.append(
            {
                "symbol": symbol,
                "sector": SYMBOL_SECTORS.get(symbol, "Other"),
                "price": price,
                "change": snapshot_change(snapshot_map.get(symbol)),
                "change_ratio": snapshot_change_ratio(snapshot_map.get(symbol)),
                "ema_10m": ema_values(ten_minute_candles, [5, 12, 34, 50]),
                "ema_1h": ema_1h,
                "ema_daily": ema_daily,
                "mtf_matches": mtf_matches(price, ema_1h, ema_daily),
            }
        )

    errors = []
    for label, response in (("snapshot", snapshot_response), ("5m bars", m5_response), ("1h bars", h1_response), ("daily bars", daily_response)):
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


@app.get("/api/strategy/dry-run")
def strategy_dry_run(symbols: str | None = Query(default=None)):
    selected_symbols = [symbol.strip().upper() for symbol in symbols.split(",")] if symbols else None
    return run_dry_run(selected_symbols)


def parse_symbols(symbols: str) -> list[str]:
    selected_symbols = [symbol.strip().upper() for symbol in symbols.split(",") if symbol.strip()]
    if not selected_symbols:
        raise HTTPException(status_code=400, detail="At least one symbol is required.")
    if len(selected_symbols) > 25:
        raise HTTPException(status_code=400, detail="Use 25 symbols or fewer.")
    return selected_symbols


def is_authorized(request: Request, username: str, password: str) -> bool:
    authorization = request.headers.get("authorization", "")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "basic" or not token:
        return False
    try:
        decoded = base64.b64decode(token).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return False
    supplied_username, separator, supplied_password = decoded.partition(":")
    if not separator:
        return False
    return secrets.compare_digest(supplied_username, username) and secrets.compare_digest(
        supplied_password,
        password,
    )


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
            }
            continue
        bucket["high"] = max(bucket["high"], candle["high"])
        bucket["low"] = min(bucket["low"], candle["low"])
        bucket["close"] = candle["close"]
        bucket["volume"] += candle.get("volume", 0)
    return [buckets[key] for key in sorted(buckets)]


def completed_candles(candles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if len(candles) <= 1:
        return candles
    return candles[:-1]


def parse_iso_time(value: Any) -> datetime | None:
    if not value:
        return None
    text = str(value).replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


@app.get("/api/tradingview/analyze")
async def tradingview_analysis(
    symbol: str = Query(default="AAPL", min_length=1, max_length=16),
    exchange: str = Query(default="NASDAQ", min_length=1, max_length=16),
    timeframe: str = Query(default="1D", pattern="^(5m|15m|1h|4h|1D|1W|1M)$"),
):
    try:
        return await analyze_symbol(symbol=symbol, exchange=exchange, timeframe=timeframe)
    except TradingViewMcpError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/trade/buy")
def buy_one_share(request: BuyRequest):
    symbol = request.symbol.strip().upper()
    if symbol not in WATCHLIST:
        raise HTTPException(status_code=400, detail="Symbol is not in the approved strategy watchlist.")
    try:
        return service().buy_one_market_order(account_id=request.account_id, symbol=symbol)
    except WebullConfigurationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
