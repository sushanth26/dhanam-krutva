import asyncio
import time
import ssl
from datetime import date, datetime, timedelta
from typing import Any
from urllib.parse import quote
from urllib.request import Request, urlopen
import json

from fastapi import APIRouter, HTTPException, Query

from app.config import get_settings
from app.insider_data import load_recent_sec_records, load_sec_records_for_targets, merge_insider_records


router = APIRouter(prefix="/api/insiders")

NASDAQ_API_BASE_URL = "https://api.nasdaq.com"
NASDAQ_100_URL = f"{NASDAQ_API_BASE_URL}/api/quote/list-type/nasdaq100"
CACHE_TTL_SECONDS = 6 * 60 * 60
SEC_LOOKBACK_DAYS = 14
SEC_PAYLOAD_TTL_SECONDS = 2 * 60
_cache: dict[str, tuple[float, Any]] = {}
_recent_sec_cache: tuple[float, dict[str, Any]] | None = None
_recent_sec_lock = asyncio.Lock()
_historical_sec_lock = asyncio.Lock()


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
                "recordId": "",
                "transactionDate": filed.isoformat(),
                "filingDate": "",
                "filedAt": "",
                "ticker": ticker,
                "companyName": holding["companyName"],
                "marketCap": holding["marketCap"],
                "insider": row.get("insider") or "Unknown insider",
                "role": row.get("relation") or "Not specified",
                "transactionType": row.get("transactionType") or "Unknown",
                "transactionCode": "",
                "isOpenMarketPurchase": str(row.get("transactionType") or "").lower() == "buy",
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


async def _load_nasdaq_history(days: int) -> dict[str, Any]:
    cache_key = f"qqq:nasdaq:{days}"
    cached = _cache.get(cache_key)
    if cached and time.time() - cached[0] < CACHE_TTL_SECONDS:
        return cached[1]

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
    records.sort(key=lambda item: (item["transactionDate"], item["value"]), reverse=True)
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


async def load_recent_sec_payload() -> dict[str, Any]:
    global _recent_sec_cache
    if _recent_sec_cache and time.time() - _recent_sec_cache[0] < SEC_PAYLOAD_TTL_SECONDS:
        return _recent_sec_cache[1]

    async with _recent_sec_lock:
        if _recent_sec_cache and time.time() - _recent_sec_cache[0] < SEC_PAYLOAD_TTL_SECONDS:
            return _recent_sec_cache[1]
        holdings = await _load_nasdaq_100()
        settings = get_settings()
        cutoff = date.today() - timedelta(days=SEC_LOOKBACK_DAYS - 1)
        records, companies_scanned = await load_recent_sec_records(
            holdings,
            user_agent=settings.sec_user_agent,
            cutoff=cutoff,
        )
        payload = {
            "days": SEC_LOOKBACK_DAYS,
            "records": records,
            "alertRecords": records,
            "source": "SEC EDGAR Form 4",
            "universeSource": "Nasdaq-100 list",
            "holdingsRequested": len(holdings),
            "holdingsScanned": companies_scanned,
            "holdingsAsOf": datetime.now().strftime("%b %-d, %Y"),
            "totalFilingsFound": len(records),
        }
        _recent_sec_cache = (time.time(), payload)
        return payload


@router.get("/qqq/recent")
async def qqq_recent_insider_buys():
    try:
        return await load_recent_sec_payload()
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Unable to load recent SEC Form 4 filings: {exc}") from exc


@router.get("/qqq/filing-details")
async def qqq_insider_filing_details(days: int = Query(default=365, ge=30, le=365)):
    cache_key = f"qqq:filing-details:{days}"
    cached = _cache.get(cache_key)
    if cached and time.time() - cached[0] < CACHE_TTL_SECONDS:
        return cached[1]

    try:
        async with _historical_sec_lock:
            cached = _cache.get(cache_key)
            if cached and time.time() - cached[0] < CACHE_TTL_SECONDS:
                return cached[1]
            nasdaq_payload = await _load_nasdaq_history(days)
            sec_records, companies_scanned = await load_sec_records_for_targets(
                nasdaq_payload.get("records", []),
                user_agent=get_settings().sec_user_agent,
            )
            recent_records = _recent_sec_cache[1].get("records", []) if _recent_sec_cache else []
            records = merge_insider_records([*recent_records, *sec_records], nasdaq_payload.get("records", []))
            payload = {
                **nasdaq_payload,
                "records": records,
                "source": "SEC EDGAR Form 4 + Nasdaq insider activity",
                "totalFilingsFound": len(records),
                "historicalFilingsMatched": len(sec_records),
                "historicalCompaniesScanned": companies_scanned,
            }
            _cache[cache_key] = (time.time(), payload)
            return payload
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Unable to match historical SEC filings: {exc}") from exc


@router.get("/qqq")
async def qqq_insider_buys(days: int = Query(default=365, ge=30, le=365)):
    try:
        nasdaq_payload = await _load_nasdaq_history(days)
        sec_payload = _recent_sec_cache[1] if _recent_sec_cache else {}
        sec_records = sec_payload.get("records", [])
        records = merge_insider_records(sec_records, nasdaq_payload.get("records", []))
        return {
            **nasdaq_payload,
            "records": records,
            "alertRecords": sec_records,
            "source": "SEC EDGAR Form 4 + Nasdaq insider activity",
            "totalFilingsFound": len(records),
            "secFilingsFound": len(sec_records),
            "secPending": not bool(_recent_sec_cache),
            "filingDetailsPending": any(not record.get("filingDate") for record in records),
            "secError": "",
        }
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Unable to load insider activity: {exc}") from exc
