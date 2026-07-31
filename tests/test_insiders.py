import asyncio
from datetime import date
from types import SimpleNamespace

import app.insider_monitor as insider_monitor
from app.insider_data import (
    merge_insider_records,
    parse_form4_xml,
    recent_form4_filings,
    sec_document_url,
)
from app.insider_monitor import InsiderPushMonitor
from app.notifications import AlertHistoryStore


FORM4_XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<ownershipDocument xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable">
  <issuer>
    <issuerCik>0000123456</issuerCik>
    <issuerName>Example Corp</issuerName>
    <issuerTradingSymbol>EXM</issuerTradingSymbol>
  </issuer>
  <reportingOwner>
    <reportingOwnerId><rptOwnerName>DOE JANE</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector>1</isDirector>
      <isOfficer>1</isOfficer>
      <officerTitle>Chief Financial Officer</officerTitle>
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-07-28</value></transactionDate>
      <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>1250</value></transactionShares>
        <transactionPricePerShare><value>42.50</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-07-28</value></transactionDate>
      <transactionCoding><transactionCode>S</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>100</value></transactionShares>
        <transactionPricePerShare><value>50</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>
"""


def filing(accession="0000123456-26-000001"):
    return {
        "accessionNumber": accession,
        "acceptanceDateTime": "20260730163045",
        "filingDate": "2026-07-30",
        "primaryDocument": "xslF345X06/ownership.xml",
    }


def test_form4_parser_returns_only_open_market_purchase_with_both_dates():
    records = parse_form4_xml(
        FORM4_XML,
        holding={"ticker": "EXM", "companyName": "Example", "marketCap": 5_000_000_000},
        filing=filing(),
        source_url="https://sec.example/ownership.xml",
    )

    assert len(records) == 1
    assert records[0]["transactionCode"] == "P"
    assert records[0]["transactionDate"] == "2026-07-28"
    assert records[0]["filingDate"] == "2026-07-30"
    assert records[0]["filedAt"] == "2026-07-30T20:30:45Z"
    assert records[0]["shares"] == 1250
    assert records[0]["price"] == 42.5
    assert records[0]["value"] == 53125
    assert records[0]["role"] == "Chief Financial Officer / Director"
    assert records[0]["isExecutiveBuy"] is True
    assert records[0]["isBoardBuy"] is True


def test_recent_form4_filings_ignores_amendments_and_old_filings():
    payload = {
        "filings": {
            "recent": {
                "form": ["4", "4/A", "4"],
                "filingDate": ["2026-07-30", "2026-07-30", "2026-06-01"],
                "acceptanceDateTime": ["20260730163045", "20260730170000", "20260601100000"],
                "accessionNumber": ["one", "amended", "old"],
                "primaryDocument": ["one.xml", "amended.xml", "old.xml"],
            }
        }
    }

    assert recent_form4_filings(payload, date(2026, 7, 20)) == [
        {
            "accessionNumber": "one",
            "acceptanceDateTime": "20260730163045",
            "filingDate": "2026-07-30",
            "primaryDocument": "one.xml",
        }
    ]


def test_sec_document_url_removes_transform_directory():
    assert sec_document_url(1652044, "0001193125-26-326284", "xslF345X06/ownership.xml") == (
        "https://www.sec.gov/Archives/edgar/data/1652044/000119312526326284/ownership.xml"
    )


def test_sec_record_replaces_matching_nasdaq_fallback():
    sec_record = parse_form4_xml(
        FORM4_XML,
        holding={"ticker": "EXM", "companyName": "Example", "marketCap": 1},
        filing=filing(),
        source_url="https://sec.example/ownership.xml",
    )[0]
    nasdaq_record = {
        **sec_record,
        "recordId": "",
        "accessionNumber": "",
        "filedAt": "",
        "source": "Nasdaq insider activity",
    }

    merged = merge_insider_records([sec_record], [nasdaq_record])

    assert len(merged) == 1
    assert merged[0]["source"] == "SEC EDGAR Form 4"


def test_insider_monitor_baselines_then_alerts_for_new_filing(tmp_path, monkeypatch):
    first = parse_form4_xml(
        FORM4_XML,
        holding={"ticker": "EXM", "companyName": "Example", "marketCap": 1},
        filing=filing("0000123456-26-000001"),
        source_url="https://sec.example/one.xml",
    )[0]
    second = {
        **first,
        "recordId": "0000123456-26-000002:0",
        "accessionNumber": "0000123456-26-000002",
        "ticker": "NEW",
        "sourceUrl": "https://sec.example/two.xml",
    }
    payloads = iter(
        [
            {"records": [first], "holdingsRequested": 100, "holdingsScanned": 100},
            {"records": [second, first], "holdingsRequested": 100, "holdingsScanned": 100},
        ]
    )

    async def fake_recent_payload():
        return next(payloads)

    monkeypatch.setattr(insider_monitor, "load_recent_sec_payload", fake_recent_payload)
    settings = SimpleNamespace(
        alert_history_file=tmp_path / "alerts.json",
        insider_push_enabled=True,
        insider_push_poll_seconds=120,
        insider_seen_file=tmp_path / "insider-seen.json",
        push_configured=True,
        push_subscription_file=tmp_path / "push.json",
        vapid_private_key="private",
        vapid_subject="mailto:test@example.com",
    )
    monitor = InsiderPushMonitor(settings)
    sent = []
    monkeypatch.setattr(monitor.sender, "send", lambda payload: sent.append(payload) or {"sent": 1})

    assert asyncio.run(monitor.check_once()) is None
    notification = asyncio.run(monitor.check_once())

    assert notification["title"] == "New insider buy: NEW"
    assert notification["records"][0]["accessionNumber"] == "0000123456-26-000002"
    assert sent == [notification]
    assert AlertHistoryStore(settings.alert_history_file).all()[0]["symbol"] == "NEW"
