import asyncio
import json
from datetime import datetime
from pathlib import Path
from typing import Any

from app.config import Settings
from app.insider_data import insider_record_key
from app.notifications import AlertHistoryStore, MtfPushMonitor, alert_history_entries_from_push, utc_now
from app.routers.insiders import load_recent_sec_payload


class InsiderSeenStore:
    def __init__(self, path: Path, max_items: int = 2000):
        self.path = path
        self.max_items = max_items

    def load(self) -> set[str] | None:
        if not self.path.exists():
            return None
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if not isinstance(payload, dict) or payload.get("initialized") is not True:
            return None
        keys = payload.get("keys", [])
        return {str(key) for key in keys if key}

    def save(self, keys: set[str]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "initialized": True,
            "keys": sorted(keys)[-self.max_items :],
            "updatedAt": utc_now(),
        }
        self.path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


class InsiderPushMonitor:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.sender = MtfPushMonitor(settings)
        self.store = self.sender.store
        self.seen_store = InsiderSeenStore(settings.insider_seen_file)
        self.seen_keys = self.seen_store.load()
        self.task: asyncio.Task | None = None
        self.last_error: str | None = None
        self.last_checked_at: str | None = None
        self.last_success_at: str | None = None
        self.last_notification_at: str | None = None
        self.last_send_result: dict[str, int] = {"sent": 0, "removed": 0, "skipped": 0, "failed": 0}

    def start(self) -> None:
        if self.task or not self.settings.insider_push_enabled or not self.settings.push_configured:
            return
        self.task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if not self.task:
            return
        self.task.cancel()
        try:
            await self.task
        except asyncio.CancelledError:
            pass
        self.task = None

    async def _run(self) -> None:
        while True:
            try:
                if self.store.all():
                    await self.check_once()
            except Exception as exc:
                self.last_error = str(exc)
            await asyncio.sleep(self.settings.insider_push_poll_seconds)

    async def check_once(self) -> dict[str, Any] | None:
        self.last_checked_at = utc_now()
        payload = await load_recent_sec_payload()
        records = payload.get("records", [])
        next_keys = {insider_record_key(record) for record in records}
        requested = int(payload.get("holdingsRequested") or 0)
        scanned = int(payload.get("holdingsScanned") or 0)

        if self.seen_keys is None:
            if requested and scanned < max(1, int(requested * 0.8)):
                raise RuntimeError(f"SEC baseline incomplete: scanned {scanned} of {requested} companies")
            self.seen_keys = next_keys
            self.seen_store.save(self.seen_keys)
            self.last_error = None
            self.last_success_at = utc_now()
            return None

        new_records = [record for record in records if insider_record_key(record) not in self.seen_keys]
        self.seen_keys.update(next_keys)
        self.seen_store.save(self.seen_keys)
        self.last_error = None
        self.last_success_at = utc_now()
        if not new_records:
            return None

        notification = insider_notification_payload(new_records)
        AlertHistoryStore(self.settings.alert_history_file).append(
            alert_history_entries_from_push(notification)
        )
        self.last_send_result = self.sender.send(notification)
        self.last_notification_at = utc_now()
        return notification

    def status(self) -> dict[str, Any]:
        return {
            "running": bool(self.task and not self.task.done()),
            "push_polling_enabled": self.settings.insider_push_enabled,
            "poll_seconds": self.settings.insider_push_poll_seconds,
            "subscriptions": len(self.store.all()),
            "last_error": self.last_error,
            "last_checked_at": self.last_checked_at,
            "last_success_at": self.last_success_at,
            "last_notification_at": self.last_notification_at,
            "last_send_result": self.last_send_result,
        }


def insider_notification_payload(records: list[dict[str, Any]]) -> dict[str, Any]:
    sorted_records = sorted(records, key=lambda item: item.get("filedAt") or "", reverse=True)
    top = sorted_records[0] if sorted_records else {}
    count = len(sorted_records)
    ticker = str(top.get("ticker") or "QQQ").upper()
    if count == 1:
        shares = _format_shares(top.get("shares"))
        price = _format_price(top.get("price"))
        trade_date = _format_date(top.get("transactionDate"))
        title = f"New insider buy: {ticker}"
        body = f"{top.get('insider') or 'An insider'} bought {shares} shares at {price} on {trade_date}. Form 4 filed now."
    else:
        symbols = list(dict.fromkeys(str(record.get("ticker") or "").upper() for record in sorted_records))
        preview = ", ".join(symbol for symbol in symbols[:4] if symbol)
        if len(symbols) > 4:
            preview += f" +{len(symbols) - 4}"
        title = f"{count} new insider purchases"
        body = f"SEC Form 4 filings received for {preview}."

    compact_records = [
        {
            key: record.get(key)
            for key in (
                "recordId",
                "accessionNumber",
                "ticker",
                "insider",
                "transactionDate",
                "filingDate",
                "filedAt",
                "shares",
                "price",
                "value",
            )
        }
        for record in sorted_records[:5]
    ]
    tag_id = top.get("accessionNumber") or top.get("recordId") or "batch"
    return {
        "kind": "insider",
        "title": title,
        "body": body,
        "badgeCount": count,
        "badge_count": count,
        "tag": f"insider-buy-{tag_id}",
        "targetSymbol": ticker,
        "target_symbol": ticker,
        "url": "/#insiders",
        "records": compact_records,
    }


def _format_shares(value: Any) -> str:
    try:
        return f"{float(value):,.0f}"
    except (TypeError, ValueError):
        return "an undisclosed number of"


def _format_price(value: Any) -> str:
    try:
        return f"${float(value):,.2f}"
    except (TypeError, ValueError):
        return "an undisclosed price"


def _format_date(value: Any) -> str:
    try:
        parsed = datetime.fromisoformat(str(value))
        return f"{parsed.strftime('%b')} {parsed.day}"
    except ValueError:
        return str(value or "the reported date")
