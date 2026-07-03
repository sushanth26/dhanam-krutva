from fastapi import APIRouter, HTTPException, Query

from app.tradingview_mcp import TradingViewMcpError, analyze_symbol


router = APIRouter(prefix="/api/tradingview")


@router.get("/analyze")
async def tradingview_analysis(
    symbol: str = Query(default="AAPL", min_length=1, max_length=16),
    exchange: str = Query(default="NASDAQ", min_length=1, max_length=16),
    timeframe: str = Query(default="1D", pattern="^(5m|15m|1h|4h|1D|1W|1M)$"),
):
    try:
        return await analyze_symbol(symbol=symbol, exchange=exchange, timeframe=timeframe)
    except TradingViewMcpError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
