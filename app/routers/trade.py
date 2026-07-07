from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator

from app.config import get_settings
from app.dependencies import service
from app.webull_service import WebullConfigurationError
from app.watchlists import WatchlistStore


router = APIRouter(prefix="/api/trade")


class BuyRequest(BaseModel):
    account_id: str = Field(min_length=1)
    symbol: str = Field(min_length=1, max_length=12)


class AutoLongRequest(BuyRequest):
    entry_price: float = Field(gt=0)
    stop_price: float = Field(gt=0)
    target_price: float = Field(gt=0)
    setup: str = Field(default="", max_length=80)
    candle_time: str = Field(default="", max_length=80)

    @field_validator("symbol")
    @classmethod
    def normalize_symbol(cls, value: str) -> str:
        return value.strip().upper()

    @model_validator(mode="after")
    def validate_long_bracket(self):
        if not (self.stop_price < self.entry_price < self.target_price):
            raise ValueError("Long bracket must have stop < entry < target.")
        return self


@router.post("/buy")
def buy_one_share(request: BuyRequest):
    symbol = request.symbol.strip().upper()
    if symbol not in approved_trade_symbols():
        raise HTTPException(status_code=400, detail="Symbol is not in the approved strategy watchlist.")
    try:
        return service().buy_one_market_order(account_id=request.account_id, symbol=symbol)
    except WebullConfigurationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/auto-long")
def auto_buy_one_share_with_take_profit(request: AutoLongRequest):
    symbol = request.symbol.strip().upper()
    if symbol not in approved_trade_symbols():
        raise HTTPException(status_code=400, detail="Symbol is not in the approved strategy watchlist.")
    try:
        return service().buy_one_with_take_profit(
            account_id=request.account_id,
            symbol=symbol,
            entry_price=round(request.entry_price, 4),
            stop_price=round(request.stop_price, 4),
            target_price=round(request.target_price, 4),
        )
    except WebullConfigurationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def approved_trade_symbols() -> set[str]:
    symbols: set[str] = set()
    for watchlist in WatchlistStore(get_settings().watchlist_file).all():
        symbols.update(str(symbol or "").strip().upper() for symbol in watchlist.get("symbols", []))
    return {symbol for symbol in symbols if symbol}
