from fastapi import APIRouter, HTTPException, Query

from app.config import get_settings
from app.notifications import latest_bounce_alerts
from app.strategy import run_dry_run


router = APIRouter(prefix="/api/strategy")


@router.get("/dry-run")
def strategy_dry_run(symbols: str | None = Query(default=None)):
    selected_symbols = [symbol.strip().upper() for symbol in symbols.split(",")] if symbols else None
    return run_dry_run(selected_symbols)


@router.get("/bounces")
def strategy_bounces():
    try:
        return latest_bounce_alerts(get_settings())
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
