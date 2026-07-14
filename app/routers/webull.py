from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from webull.data.common.category import Category

from app.config import get_settings
from app.dependencies import service
from app.alert_history import AlertHistoryStore
from app.live_data_gate import manual_unlock_for_today
from app.market_data import LIVE_WATCHLIST, build_live_prices
from app.watchlists import WatchlistStore
from app.webull_service import WebullConfigurationError


router = APIRouter(prefix="/api/webull")


class WatchlistsPayload(BaseModel):
    watchlists: list[dict[str, Any]]


class AlertHistoryPayload(BaseModel):
    alerts: list[dict[str, Any]]


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
    manual: bool = Query(default=False),
):
    settings = get_settings()
    try:
        payload = build_live_prices(
            service(),
            symbols,
            risk_amount=risk_amount,
            stop_mode=stop_mode,
            fixed_stop_buffer=fixed_stop_buffer,
        )
        if manual:
            manual_unlock_for_today(settings)
        return payload
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


@router.get("/mtf-alerts")
def get_mtf_alerts():
    settings = get_settings()
    return {"alerts": AlertHistoryStore(settings.alert_history_file).all()}


@router.post("/mtf-alerts")
def save_mtf_alerts(payload: AlertHistoryPayload):
    settings = get_settings()
    return {"alerts": AlertHistoryStore(settings.alert_history_file).upsert_many(payload.alerts)}


@router.delete("/mtf-alerts/{alert_id}")
def delete_mtf_alert(alert_id: str):
    settings = get_settings()
    return {"alerts": AlertHistoryStore(settings.alert_history_file).delete(alert_id)}


@router.delete("/mtf-alerts")
def delete_all_mtf_alerts():
    settings = get_settings()
    return {"alerts": AlertHistoryStore(settings.alert_history_file).delete_all()}
