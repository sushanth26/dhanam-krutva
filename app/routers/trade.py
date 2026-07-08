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
    limit_price: float | None = Field(default=None, gt=0)


class AutoLongRequest(BuyRequest):
    quantity: int = Field(ge=1)
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
    if request.limit_price is None:
        raise HTTPException(status_code=400, detail="Limit price is required for buy orders.")
    try:
        webull = service()
        require_margin_account(webull, request.account_id)
        return webull.buy_one_order(
            account_id=request.account_id,
            symbol=symbol,
            limit_price=round(request.limit_price, 4),
        )
    except WebullConfigurationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/auto-long")
def auto_buy_with_bracket(request: AutoLongRequest):
    symbol = request.symbol.strip().upper()
    if symbol not in approved_trade_symbols():
        raise HTTPException(status_code=400, detail="Symbol is not in the approved strategy watchlist.")
    try:
        webull = service()
        require_margin_account(webull, request.account_id)
        return webull.buy_with_bracket(
            account_id=request.account_id,
            symbol=symbol,
            quantity=request.quantity,
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


def require_margin_account(webull, account_id: str) -> None:
    accounts_payload = webull.account_list()
    account = find_account_record(accounts_payload.get("data", accounts_payload), account_id)
    if not account or "MARGIN" not in account_type_text(account):
        raise HTTPException(status_code=400, detail="Trading requires a margin account.")


def find_account_record(value, account_id: str):
    if isinstance(value, list):
        for item in value:
            found = find_account_record(item, account_id)
            if found:
                return found
    if isinstance(value, dict):
        if account_record_id(value) == account_id:
            return value
        for item in value.values():
            found = find_account_record(item, account_id)
            if found:
                return found
    return None


def account_record_id(value: dict) -> str | None:
    for key in ("account_id", "accountId", "id"):
        if value.get(key):
            return str(value[key])
    return None


def account_type_text(value) -> str:
    if isinstance(value, list):
        for item in value:
            found = account_type_text(item)
            if found:
                return found
    if isinstance(value, dict):
        for key in ("account_type", "accountType", "accountTypeName", "type", "broker"):
            if value.get(key):
                return str(value[key]).upper()
        for item in value.values():
            found = account_type_text(item)
            if found:
                return found
    return ""
