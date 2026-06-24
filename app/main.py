from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.config import get_settings
from app.strategy import WATCHLIST, run_dry_run
from app.webull_service import WebullConfigurationError, WebullService


app = FastAPI(title="Dhanam Krutva Webull Dashboard")
app.mount("/static", StaticFiles(directory="app/static"), name="static")


class BuyRequest(BaseModel):
    account_id: str = Field(min_length=1)
    symbol: str = Field(min_length=1, max_length=12)


def service() -> WebullService:
    return WebullService(get_settings())


@app.get("/")
def index() -> FileResponse:
    return FileResponse("app/static/index.html")


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


@app.get("/api/strategy/dry-run")
def strategy_dry_run(symbols: str | None = Query(default=None)):
    selected_symbols = [symbol.strip().upper() for symbol in symbols.split(",")] if symbols else None
    return run_dry_run(selected_symbols)


@app.post("/api/trade/buy")
def buy_one_share(request: BuyRequest):
    symbol = request.symbol.strip().upper()
    if symbol not in WATCHLIST:
        raise HTTPException(status_code=400, detail="Symbol is not in the approved strategy watchlist.")
    try:
        return service().buy_one_market_order(account_id=request.account_id, symbol=symbol)
    except WebullConfigurationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
