import asyncio
import json
import ssl
import threading
import time
from datetime import UTC, date, datetime
from pathlib import PurePosixPath
from typing import Any
from urllib.request import Request, urlopen
from xml.etree import ElementTree
from zoneinfo import ZoneInfo


SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
SEC_SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik:010d}.json"
SEC_ARCHIVES_URL = "https://www.sec.gov/Archives/edgar/data/{cik}/{accession}/{document}"
SEC_TICKERS_TTL_SECONDS = 24 * 60 * 60
SEC_SUBMISSIONS_TTL_SECONDS = 2 * 60
SEC_DOCUMENT_TTL_SECONDS = 7 * 24 * 60 * 60
SEC_REQUEST_INTERVAL_SECONDS = 0.12
SEC_REQUEST_CONCURRENCY = 6

_cache: dict[str, tuple[float, Any]] = {}
_request_lock = threading.Lock()
_last_request_at = 0.0


def _parse_number(value: Any) -> float:
    text = str(value or "").replace("$", "").replace(",", "").strip()
    try:
        return float(text)
    except (TypeError, ValueError):
        return 0.0


def _sec_request_sync(url: str, user_agent: str) -> bytes:
    global _last_request_at
    with _request_lock:
        delay = SEC_REQUEST_INTERVAL_SECONDS - (time.monotonic() - _last_request_at)
        if delay > 0:
            time.sleep(delay)
        _last_request_at = time.monotonic()

    request = Request(
        url,
        headers={
            "User-Agent": user_agent,
            "Accept": "application/json, application/xml, text/xml, */*",
            "Accept-Encoding": "identity",
        },
    )
    context = ssl._create_unverified_context()
    with urlopen(request, timeout=20, context=context) as response:
        return response.read()


async def _fetch_sec_bytes(url: str, user_agent: str, ttl_seconds: int) -> bytes:
    cache_key = f"sec:{url}"
    cached = _cache.get(cache_key)
    if cached and time.time() - cached[0] < ttl_seconds:
        return cached[1]
    value = await asyncio.to_thread(_sec_request_sync, url, user_agent)
    _cache[cache_key] = (time.time(), value)
    return value


async def _fetch_sec_json(url: str, user_agent: str, ttl_seconds: int) -> Any:
    raw = await _fetch_sec_bytes(url, user_agent, ttl_seconds)
    return json.loads(raw.decode("utf-8"))


async def load_sec_ticker_ciks(user_agent: str) -> dict[str, int]:
    payload = await _fetch_sec_json(SEC_TICKERS_URL, user_agent, SEC_TICKERS_TTL_SECONDS)
    rows = payload.values() if isinstance(payload, dict) else []
    return {
        str(row.get("ticker") or "").strip().upper().replace(".", "-"): int(row.get("cik_str"))
        for row in rows
        if isinstance(row, dict) and row.get("ticker") and row.get("cik_str")
    }


def recent_form4_filings(payload: dict[str, Any], cutoff: date) -> list[dict[str, str]]:
    recent = payload.get("filings", {}).get("recent", {})
    if not isinstance(recent, dict):
        return []

    forms = recent.get("form", [])
    output = []
    for index, form in enumerate(forms):
        if str(form or "").strip() != "4":
            continue
        filing_date = _list_value(recent, "filingDate", index)
        try:
            parsed_filing_date = date.fromisoformat(filing_date)
        except ValueError:
            continue
        if parsed_filing_date < cutoff:
            continue
        accession = _list_value(recent, "accessionNumber", index)
        document = _list_value(recent, "primaryDocument", index)
        if not accession or not document:
            continue
        output.append(
            {
                "accessionNumber": accession,
                "acceptanceDateTime": _list_value(recent, "acceptanceDateTime", index),
                "filingDate": filing_date,
                "primaryDocument": document,
            }
        )
    return output


def _list_value(data: dict[str, Any], key: str, index: int) -> str:
    values = data.get(key, [])
    if not isinstance(values, list) or index >= len(values):
        return ""
    return str(values[index] or "").strip()


def sec_document_url(cik: int, accession_number: str, primary_document: str) -> str:
    accession_path = accession_number.replace("-", "")
    document_name = PurePosixPath(primary_document).name
    return SEC_ARCHIVES_URL.format(cik=int(cik), accession=accession_path, document=document_name)


def parse_form4_xml(
    xml_bytes: bytes,
    *,
    holding: dict[str, Any],
    filing: dict[str, str],
    source_url: str,
) -> list[dict[str, Any]]:
    root = ElementTree.fromstring(xml_bytes)
    owner = _first(root, "reportingOwner")
    relationship = _first(owner, "reportingOwnerRelationship")
    insider = _text(owner, "reportingOwnerId/rptOwnerName") or "Unknown insider"
    is_officer = _truthy(_text(relationship, "isOfficer"))
    is_director = _truthy(_text(relationship, "isDirector"))
    if not (is_officer or is_director):
        return []

    role_parts = []
    officer_title = _text(relationship, "officerTitle")
    if is_officer:
        role_parts.append(officer_title or "Officer")
    if is_director:
        role_parts.append("Director")
    role = " / ".join(dict.fromkeys(role_parts))
    filed_at = format_sec_acceptance_datetime(filing.get("acceptanceDateTime"))
    accession = filing.get("accessionNumber") or ""
    ticker = str(_text(root, "issuer/issuerTradingSymbol") or holding.get("ticker") or "").upper()
    company_name = _text(root, "issuer/issuerName") or holding.get("companyName") or ticker

    records = []
    for index, transaction in enumerate(_all(root, "nonDerivativeTransaction")):
        transaction_code = _text(transaction, "transactionCoding/transactionCode").upper()
        acquired_disposed = _text(
            transaction,
            "transactionAmounts/transactionAcquiredDisposedCode/value",
        ).upper()
        if transaction_code != "P" or acquired_disposed != "A":
            continue

        shares = _parse_number(_text(transaction, "transactionAmounts/transactionShares/value"))
        price = _parse_number(_text(transaction, "transactionAmounts/transactionPricePerShare/value"))
        transaction_date = _text(transaction, "transactionDate/value")
        if shares <= 0 or not transaction_date:
            continue
        ownership_code = _text(transaction, "ownershipNature/directOrIndirectOwnership/value").upper()
        ownership = {"D": "Direct", "I": "Indirect"}.get(ownership_code, ownership_code or "Not specified")
        records.append(
            {
                "recordId": f"{accession}:{index}",
                "accessionNumber": accession,
                "transactionDate": transaction_date,
                "filingDate": filing.get("filingDate") or "",
                "filedAt": filed_at,
                "ticker": ticker,
                "companyName": company_name,
                "marketCap": holding.get("marketCap") or 0,
                "insider": insider,
                "role": role,
                "transactionType": "Open-market purchase",
                "transactionCode": "P",
                "isOpenMarketPurchase": True,
                "shares": shares,
                "price": price,
                "value": shares * price,
                "ownership": ownership,
                "securityTitle": _text(transaction, "securityTitle/value") or "Common stock",
                "source": "SEC EDGAR Form 4",
                "sourceUrl": source_url,
                "isExecutiveBuy": is_officer,
                "isBoardBuy": is_director,
            }
        )
    return records


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _first(element: ElementTree.Element | None, path: str) -> ElementTree.Element | None:
    matches = _find_path(element, path)
    return matches[0] if matches else None


def _all(element: ElementTree.Element | None, name: str) -> list[ElementTree.Element]:
    if element is None:
        return []
    return [child for child in element.iter() if _local_name(child.tag) == name]


def _find_path(element: ElementTree.Element | None, path: str) -> list[ElementTree.Element]:
    if element is None:
        return []
    current = [element]
    for part in path.split("/"):
        next_items = []
        for item in current:
            next_items.extend(child for child in item if _local_name(child.tag) == part)
        current = next_items
        if not current:
            break
    return current


def _text(element: ElementTree.Element | None, path: str) -> str:
    match = _first(element, path)
    return str(match.text or "").strip() if match is not None else ""


def _truthy(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes"}


def format_sec_acceptance_datetime(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    for date_format in ("%Y%m%d%H%M%S", "%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ"):
        try:
            parsed = datetime.strptime(text, date_format)
            if date_format == "%Y%m%d%H%M%S":
                parsed = parsed.replace(tzinfo=ZoneInfo("America/New_York"))
            else:
                parsed = parsed.replace(tzinfo=UTC)
            return parsed.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
        except ValueError:
            continue
    return text


async def load_recent_sec_records(
    holdings: list[dict[str, Any]],
    *,
    user_agent: str,
    cutoff: date,
) -> tuple[list[dict[str, Any]], int]:
    ticker_ciks = await load_sec_ticker_ciks(user_agent)
    semaphore = asyncio.Semaphore(SEC_REQUEST_CONCURRENCY)

    async def load_company(holding: dict[str, Any]) -> tuple[list[dict[str, Any]], bool]:
        ticker = str(holding.get("ticker") or "").upper().replace(".", "-")
        cik = ticker_ciks.get(ticker)
        if not cik:
            return [], False
        async with semaphore:
            submissions = await _fetch_sec_json(
                SEC_SUBMISSIONS_URL.format(cik=cik),
                user_agent,
                SEC_SUBMISSIONS_TTL_SECONDS,
            )

        records = []
        for filing in recent_form4_filings(submissions, cutoff):
            source_url = sec_document_url(cik, filing["accessionNumber"], filing["primaryDocument"])
            async with semaphore:
                xml_bytes = await _fetch_sec_bytes(source_url, user_agent, SEC_DOCUMENT_TTL_SECONDS)
            records.extend(
                parse_form4_xml(
                    xml_bytes,
                    holding=holding,
                    filing=filing,
                    source_url=source_url,
                )
            )
        return records, True

    results = await asyncio.gather(*(load_company(holding) for holding in holdings), return_exceptions=True)
    records = []
    companies_scanned = 0
    for result in results:
        if isinstance(result, tuple):
            company_records, scanned = result
            records.extend(company_records)
            companies_scanned += int(scanned)
    records.sort(
        key=lambda item: (item.get("filedAt") or item.get("filingDate") or "", item.get("value") or 0),
        reverse=True,
    )
    return records, companies_scanned


def insider_record_key(record: dict[str, Any]) -> str:
    record_id = str(record.get("recordId") or "").strip()
    if record_id:
        return record_id
    return ":".join(
        [
            str(record.get("ticker") or "").upper(),
            str(record.get("transactionDate") or record.get("filingDate") or ""),
            str(record.get("insider") or "").upper(),
            str(record.get("shares") or ""),
            f"{float(record.get('price') or 0):.4f}",
        ]
    )


def merge_insider_records(
    sec_records: list[dict[str, Any]],
    nasdaq_records: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    records = []
    seen_ids = set()
    sec_trade_keys = set()
    for record in sec_records:
        key = insider_record_key(record)
        if key in seen_ids:
            continue
        seen_ids.add(key)
        sec_trade_keys.add(_trade_key(record))
        records.append(record)
    for record in nasdaq_records:
        key = insider_record_key(record)
        if key in seen_ids or _trade_key(record) in sec_trade_keys:
            continue
        seen_ids.add(key)
        records.append(record)
    records.sort(
        key=lambda item: (
            item.get("filedAt") or item.get("filingDate") or item.get("transactionDate") or "",
            item.get("value") or 0,
        ),
        reverse=True,
    )
    return records


def _trade_key(record: dict[str, Any]) -> tuple[str, str, float, float]:
    return (
        str(record.get("ticker") or "").upper(),
        str(record.get("transactionDate") or record.get("filingDate") or ""),
        round(float(record.get("shares") or 0), 4),
        round(float(record.get("price") or 0), 4),
    )
