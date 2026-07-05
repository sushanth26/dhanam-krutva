import asyncio
import json
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pywebpush import WebPushException, webpush

from app.config import Settings
from app.dependencies import service
from app.market_data import LIVE_WATCHLIST, build_live_prices


DEFAULT_ALERT_STRATEGIES = {
    "hourly-cloud": True,
    "daily-fast-cloud": True,
    "daily-slow-cloud": True,
    "ten-minute-bounce": True,
}


class PushSubscriptionStore:
    def __init__(self, path: Path):
        self.path = path

    def all(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        return data if isinstance(data, list) else []

    def upsert(self, subscription: dict[str, Any]) -> int:
        endpoint = subscription.get("endpoint")
        if not endpoint:
            return len(self.all())
        subscriptions = [item for item in self.all() if item.get("endpoint") != endpoint]
        subscriptions.append(subscription)
        self._write(subscriptions)
        return len(subscriptions)

    def remove(self, endpoint: str) -> int:
        subscriptions = [item for item in self.all() if item.get("endpoint") != endpoint]
        self._write(subscriptions)
        return len(subscriptions)

    def _write(self, subscriptions: list[dict[str, Any]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(subscriptions, indent=2), encoding="utf-8")


class MtfPushMonitor:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.store = PushSubscriptionStore(settings.push_subscription_file)
        self.task: asyncio.Task | None = None
        self.last_signature: str | None = None

    def start(self) -> None:
        if self.task or not self.settings.push_configured:
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
                if self.store.all() and is_market_refresh_window(self.settings.mtf_push_timezone):
                    await asyncio.to_thread(self.check_once)
            except Exception:
                pass
            await asyncio.sleep(self.settings.mtf_push_poll_seconds)

    def check_once(self) -> dict[str, Any] | None:
        payload = build_live_prices(service(), ",".join(LIVE_WATCHLIST))
        quotes = [quote for quote in payload.get("quotes", []) if quote.get("mtf_matches")]
        signature = mtf_signature(quotes)
        changed = self.last_signature is not None and signature != self.last_signature
        self.last_signature = signature
        if not changed:
            return None

        notification = mtf_notification_payload(quotes)
        self.send(notification)
        return notification

    def send(self, payload: dict[str, Any]) -> dict[str, int]:
        if not self.settings.push_configured:
            return {"sent": 0, "removed": 0}

        sent = 0
        removed = 0
        for subscription in self.store.all():
            subscription_payload = filter_payload_by_strategies(payload, subscription.get("alert_strategies", {}))
            if not subscription_payload:
                continue
            try:
                webpush(
                    subscription_info=webpush_subscription_info(subscription),
                    data=json.dumps(subscription_payload),
                    vapid_private_key=self.settings.vapid_private_key,
                    vapid_claims={"sub": self.settings.vapid_subject},
                )
                sent += 1
            except WebPushException as exc:
                if exc.response is not None and exc.response.status_code in {404, 410}:
                    self.store.remove(subscription.get("endpoint", ""))
                    removed += 1
        return {"sent": sent, "removed": removed}


def is_market_refresh_window(timezone_name: str) -> bool:
    try:
        now = datetime.now(ZoneInfo(timezone_name))
    except ZoneInfoNotFoundError:
        now = datetime.now()
    if now.weekday() >= 5:
        return False
    minutes = now.hour * 60 + now.minute
    return 3 * 60 <= minutes < 15 * 60


def webpush_subscription_info(subscription: dict[str, Any]) -> dict[str, Any]:
    return {
        "endpoint": subscription.get("endpoint"),
        "keys": subscription.get("keys", {}),
    }


def mtf_notification_payload(quotes: list[dict[str, Any]]) -> dict[str, Any]:
    matches = describe_mtf_matches(quotes)
    return {
        "title": "MTFs changed",
        "body": matches or "No symbols are on MTF clouds now.",
        "badgeCount": len(quotes),
        "badge_count": len(quotes),
        "tag": "mtf-update",
        "url": "/",
        "matches": [
            {
                "symbol": quote.get("symbol"),
                "labels": [match.get("label") for match in quote.get("mtf_matches", [])],
            }
            for quote in quotes
        ],
    }


def describe_mtf_matches(quotes: list[dict[str, Any]]) -> str:
    parts = []
    for quote in quotes:
        labels = " + ".join(match.get("label", "") for match in quote.get("mtf_matches", []) if match.get("label"))
        if labels:
            parts.append(f"{quote.get('symbol')} {labels}")
    return " | ".join(parts)


def mtf_signature(quotes: list[dict[str, Any]]) -> str:
    return ",".join(
        sorted(
            f"{quote.get('symbol')}:{'|'.join(match.get('label', '') for match in quote.get('mtf_matches', []))}"
            for quote in quotes
        )
    )


def strategy_id_for_label(label: str) -> str:
    if label.startswith("10m bounce"):
        return "ten-minute-bounce"
    if "Hourly 34/50" in label:
        return "hourly-cloud"
    if "Daily 20/21" in label:
        return "daily-fast-cloud"
    if "Daily 50/55" in label:
        return "daily-slow-cloud"
    return "unknown"


def normalize_strategy_state(strategy_state: dict[str, Any] | None) -> dict[str, bool]:
    normalized = DEFAULT_ALERT_STRATEGIES.copy()
    if isinstance(strategy_state, dict):
        if "ten-minute-bounce" not in strategy_state and "ten-minute-touch" in strategy_state:
            normalized["ten-minute-bounce"] = bool(strategy_state["ten-minute-touch"])
        for key in normalized:
            if key in strategy_state:
                normalized[key] = bool(strategy_state[key])
    return normalized


def filter_payload_by_strategies(payload: dict[str, Any], strategy_state: dict[str, Any] | None) -> dict[str, Any] | None:
    if "matches" not in payload:
        return payload

    strategies = normalize_strategy_state(strategy_state)
    filtered_matches = []
    for item in payload.get("matches", []):
        labels = []
        for label in item.get("labels", []):
            label_text = str(label or "")
            if label_text and strategies.get(strategy_id_for_label(label_text), True):
                labels.append(label_text)
        if labels:
            filtered_matches.append({"symbol": item.get("symbol"), "labels": labels})

    if not filtered_matches:
        return None

    body = " | ".join(
        f"{item.get('symbol')} {' + '.join(item.get('labels', []))}"
        for item in filtered_matches
        if item.get("labels")
    )
    return {
        **payload,
        "body": body or payload.get("body", "MTFs changed"),
        "badgeCount": len(filtered_matches),
        "badge_count": len(filtered_matches),
        "matches": filtered_matches,
    }
