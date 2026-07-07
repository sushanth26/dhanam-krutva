from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.config import get_settings
from app.dependencies import service
from app.webull_service import WebullConfigurationError
from app.watchlists import WatchlistStore


router = APIRouter(prefix="/api/trade")


class BuyRequest(BaseModel):
    account_id: str = Field(min_length=1)
    symbol: str = Field(min_length=1, max_length=12)


@router.post("/buy")
def buy_one_share(request: BuyRequest):
    symbol = request.symbol.strip().upper()
    if symbol not in approved_trade_symbols():
        raise HTTPException(status_code=400, detail="Symbol is not in the approved strategy watchlist.")
    try:
        return service().buy_one_market_order(account_id=request.account_id, symbol=symbol)
    except WebullConfigurationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def approved_trade_symbols() -> set[str]:
    symbols: set[str] = set()
    for watchlist in WatchlistStore(get_settings().watchlist_file).all():
        symbols.update(str(symbol or "").strip().upper() for symbol in watchlist.get("symbols", []))
    return {symbol for symbol in symbols if symbol}
