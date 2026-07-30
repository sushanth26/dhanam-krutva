import asyncio
import time
import ssl
from datetime import date, datetime, timedelta
from typing import Any
from urllib.parse import quote
from urllib.request import Request, urlopen
import json

from fastapi import APIRouter, HTTPException, Query


router = APIRouter(prefix="/api/insiders")

NASDAQ_API_BASE_URL = "https://api.nasdaq.com"
NASDAQ_100_URL = f"{NASDAQ_API_BASE_URL}/api/quote/list-type/nasdaq100"
CACHE_TTL_SECONDS = 6 * 60 * 60
_cache: dict[str, tuple[float, Any]] = {}


def _parse_number(value: Any) -> float:
    text = str(value or "").replace("$", "").replace(",", "").replace("(", "").replace(")", "").strip()
    try:
        return float(text)
    except ValueError:
        return 0.0


def _parse_nasdaq_date(value: Any) -> date | None:
    try:
        return datetime.strptime(str(value), "%m/%d/%Y").date()
    except ValueError:
        return None


def _fetch_json_sync(url: str) -> Any:
    request = Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            "Accept": "application/json, text/plain, */*",
            "Origin": "https://www.nasdaq.com",
            "Referer": "https://www.nasdaq.com/",
        },
    )
    context = ssl._create_unverified_context()
    with urlopen(request, timeout=20, context=context) as response:
        return json.loads(response.read().decode("utf-8"))


async def _fetch_json(url: str, ttl_seconds: int = CACHE_TTL_SECONDS) -> Any:
    cache_key = f"json:{url}"
    cached = _cache.get(cache_key)
    if cached and time.time() - cached[0] < ttl_seconds:
        return cached[1]
    value = await asyncio.to_thread(_fetch_json_sync, url)
    _cache[cache_key] = (time.time(), value)
    return value


def _is_officer_buy(row: dict[str, Any]) -> bool:
    relation = str(row.get("relation") or "")
    return str(row.get("transactionType") or "").lower() == "buy" and any(
        token in relation.lower().split()
        for token in ["officer", "chief", "ceo", "cfo", "coo", "cto", "cio", "president", "evp", "svp", "vp"]
    )


def _is_board_buy(row: dict[str, Any]) -> bool:
    relation = str(row.get("relation") or "").lower()
    return str(row.get("transactionType") or "").lower() == "buy" and (
        "director" in relation or "board" in relation or "chair" in relation
    )


async def _load_nasdaq_100() -> list[dict[str, Any]]:
    payload = await _fetch_json(NASDAQ_100_URL)
    rows = payload.get("data", {}).get("data", {}).get("rows", [])
    holdings = []
    for row in rows:
        ticker = str(row.get("symbol") or "").strip().upper()
        if not ticker:
            continue
        holdings.append(
            {
                "ticker": ticker,
                "companyName": row.get("companyName") or ticker,
                "marketCap": _parse_number(row.get("marketCap")),
            }
        )
    return holdings


async def _load_insider_rows(holding: dict[str, Any], cutoff: date) -> list[dict[str, Any]]:
    ticker = holding["ticker"]
    url = f"{NASDAQ_API_BASE_URL}/api/company/{quote(ticker)}/insider-trades?limit=200&type=ALL"
    payload = await _fetch_json(url)
    rows = payload.get("data", {}).get("transactionTable", {}).get("table", {}).get("rows", [])
    records = []
    for row in rows:
        filed = _parse_nasdaq_date(row.get("lastDate"))
        if not filed or filed < cutoff:
            continue
        if not (_is_officer_buy(row) or _is_board_buy(row)):
            continue

        shares = _parse_number(row.get("sharesTraded"))
        price = _parse_number(row.get("lastPrice"))
        records.append(
            {
                "filingDate": filed.isoformat(),
                "ticker": ticker,
                "companyName": holding["companyName"],
                "marketCap": holding["marketCap"],
                "insider": row.get("insider") or "Unknown insider",
                "role": row.get("relation") or "Not specified",
                "transactionType": row.get("transactionType") or "Unknown",
                "shares": shares,
                "price": price,
                "value": shares * price,
                "ownership": row.get("ownType") or "Not specified",
                "source": "Nasdaq insider activity",
                "sourceUrl": (
                    f"https://www.nasdaq.com{row.get('url')}"
                    if row.get("url")
                    else f"https://www.nasdaq.com/market-activity/stocks/{ticker.lower()}/insider-activity"
                ),
                "isExecutiveBuy": _is_officer_buy(row),
                "isBoardBuy": _is_board_buy(row),
            }
        )
    return records


@router.get("/qqq")
async def qqq_insider_buys(days: int = Query(default=365, ge=30, le=365)):
    cache_key = f"qqq:{days}"
    cached = _cache.get(cache_key)
    if cached and time.time() - cached[0] < CACHE_TTL_SECONDS:
        return cached[1]

    try:
      holdings = await _load_nasdaq_100()
      cutoff = date.today() - timedelta(days=days - 1)
      batches = [holdings[index : index + 8] for index in range(0, len(holdings), 8)]
      records: list[dict[str, Any]] = []
      for batch in batches:
          batch_results = await asyncio.gather(
              *(_load_insider_rows(holding, cutoff) for holding in batch),
              return_exceptions=True,
          )
          for result in batch_results:
              if isinstance(result, list):
                  records.extend(result)
      records.sort(key=lambda item: (item["filingDate"], item["value"]), reverse=True)
      payload = {
          "days": days,
          "records": records,
          "source": "Nasdaq insider activity",
          "universeSource": "Nasdaq-100 list",
          "holdingsScanned": len(holdings),
          "holdingsAsOf": datetime.now().strftime("%b %-d, %Y"),
          "totalFilingsFound": len(records),
      }
      _cache[cache_key] = (time.time(), payload)
      return payload
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Unable to load Nasdaq insider activity: {exc}") from exc
