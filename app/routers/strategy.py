from fastapi import APIRouter, Query

from app.strategy import run_dry_run


router = APIRouter(prefix="/api/strategy")


@router.get("/dry-run")
def strategy_dry_run(symbols: str | None = Query(default=None)):
    selected_symbols = [symbol.strip().upper() for symbol in symbols.split(",")] if symbols else None
    return run_dry_run(selected_symbols)
