from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from webull.data.common.category import Category

from app.config import get_settings
from app.dependencies import service
from app.market_data import LIVE_WATCHLIST, build_live_prices
from app.watchlists import WatchlistStore
from app.webull_service import WebullConfigurationError


router = APIRouter(prefix="/api/webull")


class WatchlistsPayload(BaseModel):
    watchlists: list[dict[str, Any]]


@router.get("/quote")
def webull_quote(symbol: str = Query(default="AAPL", min_length=1, max_length=16)):
    try:
        return service().live_quote(symbol=symbol, category=Category.US_STOCK.name)
    except WebullConfigurationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/live-prices")
def webull_live_prices(symbols: str = Query(default=",".join(LIVE_WATCHLIST))):
    try:
        return build_live_prices(service(), symbols)
    except WebullConfigurationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/watchlists")
def get_watchlists():
    settings = get_settings()
    return {"watchlists": WatchlistStore(settings.watchlist_file).all()}


@router.post("/watchlists")
def save_watchlists(payload: WatchlistsPayload):
    settings = get_settings()
    return {"watchlists": WatchlistStore(settings.watchlist_file).replace(payload.watchlists)}
