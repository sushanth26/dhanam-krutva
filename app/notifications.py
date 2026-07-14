import asyncio
import json
import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pywebpush import WebPushException, webpush

from app.alert_history import AlertHistoryStore
from app.alert_strategies import AlertStrategySettingsStore, filter_enabled_matches
from app.config import Settings
from app.dependencies import service
from app.live_data_gate import POST_MARKET_CLOSE_MINUTES, is_live_data_unlocked_today
from app.market_data import WEBULL_BATCH_BAR_LIMIT, build_live_prices, symbol_chunks
from app.watchlists import WatchlistStore


logger = logging.getLogger(__name__)


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
        self.last_error_signature: str | None = None

    def start(self) -> None:
        if self.task or not self.settings.mtf_push_enabled or not self.settings.push_configured:
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
                if (
                    self.store.all()
                    and is_live_data_unlocked_today(self.settings)
                    and is_market_refresh_window(self.settings.mtf_push_timezone)
                ):
                    await asyncio.to_thread(self.check_once)
                    self.last_error_signature = None
            except Exception:
                logger.exception("MTF push monitor failed")
                self.notify_monitor_error()
            await asyncio.sleep(self.settings.mtf_push_poll_seconds)

    def check_once(self) -> dict[str, Any] | None:
        strategies = AlertStrategySettingsStore(self.settings.alert_strategy_file).get()
        quotes = confirmed_mtf_quotes(build_monitored_quotes(self.settings))
        quotes = apply_enabled_strategies(quotes, strategies)
        signature = mtf_signature(quotes)
        changed = bool(signature) and signature != self.last_signature
        self.last_signature = signature
        if not changed:
            return None

        notification = mtf_notification_payload(quotes)
        save_push_alert_history(self.settings, quotes)
        self.send(notification)
        return notification

    def send(self, payload: dict[str, Any]) -> dict[str, int]:
        if not self.settings.push_configured:
            return {"sent": 0, "removed": 0}

        sent = 0
        removed = 0
        for subscription in self.store.all():
            try:
                webpush(
                    subscription_info=webpush_subscription_info(subscription),
                    data=json.dumps(payload),
                    vapid_private_key=self.settings.vapid_private_key,
                    vapid_claims={"sub": self.settings.vapid_subject},
                )
                sent += 1
            except WebPushException as exc:
                if exc.response is not None and exc.response.status_code in {404, 410}:
                    self.store.remove(subscription.get("endpoint", ""))
                    removed += 1
        return {"sent": sent, "removed": removed}

    def notify_monitor_error(self) -> dict[str, int] | None:
        signature = "webull-refresh-failed"
        if self.last_error_signature == signature:
            return None
        self.last_error_signature = signature
        return self.send(
            {
                "title": "Webull alerts paused",
                "body": "Background live-data refresh failed. Open the app and refresh Webull to resume setup alerts.",
                "badgeCount": 1,
                "badge_count": 1,
                "tag": "webull-alerts-paused",
                "targetSymbol": "",
                "url": "/",
                "matches": [],
            }
        )


def is_market_refresh_window(timezone_name: str, now: datetime | None = None) -> bool:
    if now is None:
        try:
            now = datetime.now(ZoneInfo(timezone_name))
        except ZoneInfoNotFoundError:
            now = datetime.now()
    if now.weekday() >= 5:
        return False
    minutes = now.hour * 60 + now.minute
    return 3 * 60 <= minutes < POST_MARKET_CLOSE_MINUTES


def webpush_subscription_info(subscription: dict[str, Any]) -> dict[str, Any]:
    return {
        "endpoint": subscription.get("endpoint"),
        "keys": subscription.get("keys", {}),
    }


def monitored_symbols(settings: Settings) -> list[str]:
    symbols = []
    seen = set()
    for watchlist in WatchlistStore(settings.watchlist_file).all():
        for symbol in watchlist.get("symbols", []):
            symbol_text = str(symbol or "").strip().upper()
            if symbol_text and symbol_text not in seen:
                symbols.append(symbol_text)
                seen.add(symbol_text)
    return symbols


def build_monitored_quotes(settings: Settings) -> list[dict[str, Any]]:
    quotes = []
    errors = []
    webull = service()
    for chunk in symbol_chunks(monitored_symbols(settings), WEBULL_BATCH_BAR_LIMIT):
        if not chunk:
            continue
        payload = build_live_prices(webull, ",".join(chunk))
        if payload.get("ok") is False:
            errors.extend(payload.get("errors") or [{"source": "live prices", "error": payload}])
        quotes.extend(payload.get("quotes", []))
    if errors:
        raise RuntimeError(f"Webull live-data refresh failed: {describe_webull_errors(errors)}")
    return quotes


def describe_webull_errors(errors: list[dict[str, Any]]) -> str:
    descriptions = []
    for item in errors[:3]:
        source = item.get("source") or "webull"
        error = item.get("error") if isinstance(item, dict) else item
        if isinstance(error, dict):
            message = error.get("error") or error.get("message") or error.get("error_code") or error.get("status_code")
        else:
            message = error
        descriptions.append(f"{source}: {message or 'unknown error'}")
    if len(errors) > 3:
        descriptions.append(f"{len(errors) - 3} more")
    return "; ".join(descriptions)


def mtf_notification_payload(quotes: list[dict[str, Any]]) -> dict[str, Any]:
    notification = mtf_notification_details(quotes)
    return {
        "title": notification["title"],
        "body": notification["body"],
        "badgeCount": notification["badge_count"],
        "badge_count": notification["badge_count"],
        "tag": notification["tag"],
        "targetSymbol": notification["target_symbol"],
        "url": notification["url"],
        "matches": [
            {
                "symbol": quote.get("symbol"),
                "labels": [match.get("label") for match in quote.get("mtf_matches", [])],
                "details": [
                    {
                        "label": match.get("label"),
                        "display_label": display_label(match),
                        "entry_price": match_entry_price(match),
                    }
                    for match in quote.get("mtf_matches", [])
                    if match.get("label")
                ],
            }
            for quote in quotes
        ],
    }


def save_push_alert_history(settings: Settings, quotes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    created_at = datetime.now(UTC).isoformat()
    alerts = []
    for quote in quotes:
        symbol = str(quote.get("symbol") or "").upper()
        quote_payload = {key: value for key, value in quote.items() if key != "mtf_matches"}
        quote_payload["symbol"] = symbol
        for match in quote.get("mtf_matches", []):
            alerts.append(
                {
                    "watchlist": {"id": "push-monitor", "name": "Background monitor"},
                    "quote": quote_payload,
                    "match": match,
                    "symbol": symbol,
                    "created_at": created_at,
                }
            )
    if not alerts:
        return []
    return AlertHistoryStore(settings.alert_history_file).upsert_many(alerts)


def apply_enabled_strategies(quotes: list[dict[str, Any]], strategies: dict[str, bool]) -> list[dict[str, Any]]:
    output = []
    for quote in quotes:
        matches = filter_enabled_matches(quote.get("mtf_matches", []), strategies)
        if matches:
            output.append({**quote, "mtf_matches": matches})
    return output


def confirmed_mtf_quotes(quotes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    output = []
    for quote in quotes:
        matches = [
            match
            for match in quote.get("mtf_matches", [])
            if match.get("status", "confirmed") == "confirmed" or match.get("type") == "mtf_cloud_inside"
        ]
        if matches:
            output.append({**quote, "mtf_matches": matches})
    return output


def mtf_notification_details(quotes: list[dict[str, Any]]) -> dict[str, Any]:
    matches = [
        {
            "symbol": quote.get("symbol"),
            "labels": [
                notification_match_text(match)
                for match in quote.get("mtf_matches", [])
                if match.get("label")
            ],
        }
        for quote in quotes
    ]
    matches = [match for match in matches if match["symbol"] and match["labels"]]
    target_symbol = str(matches[0]["symbol"]) if matches else ""

    if not matches:
        return {
            "title": "No setup alerts",
            "body": "No symbols have live setups now.",
            "badge_count": 0,
            "tag": "mtf-empty",
            "target_symbol": "",
            "url": "/",
        }

    if len(matches) == 1:
        match = matches[0]
        symbol = str(match["symbol"])
        labels = [str(label) for label in match["labels"]]
        return {
            "title": f"{symbol}: {labels[0]}",
            "body": " + ".join(labels[1:]) if len(labels) > 1 else "Tap to open this setup row.",
            "badge_count": 1,
            "tag": f"mtf-{symbol}",
            "target_symbol": symbol,
            "url": mtf_url(symbol),
        }

    symbols = [str(match["symbol"]) for match in matches]
    symbol_text = ", ".join(symbols[:3])
    if len(symbols) > 3:
        symbol_text += "..."
    return {
        "title": f"{len(matches)} Setup alerts: {symbol_text}",
        "body": " • ".join(f"{match['symbol']} {match['labels'][0]}" for match in matches[:3]),
        "badge_count": len(matches),
        "tag": "mtf-batch",
        "target_symbol": target_symbol,
        "url": mtf_url(target_symbol),
    }


def mtf_url(symbol: str) -> str:
    return f"/?mtf={symbol}" if symbol else "/"


def describe_mtf_matches(quotes: list[dict[str, Any]]) -> str:
    parts = []
    for quote in quotes:
        labels = " + ".join(notification_match_text(match) for match in quote.get("mtf_matches", []) if match.get("label"))
        if labels:
            parts.append(f"{quote.get('symbol')} {labels}")
    return " | ".join(parts)


def display_label(match: dict[str, Any]) -> str:
    label = str(match.get("display_label") or match.get("label") or "")
    if match.get("trade_action") == "Short" and "bounce" in label:
        return label.replace("bounce", "rejection")
    return label


def match_entry_price(match: dict[str, Any]) -> Any:
    risk_plan = match.get("risk_plan") if isinstance(match.get("risk_plan"), dict) else {}
    return match.get("entry_price") or risk_plan.get("entry")


def notification_match_text(match: dict[str, Any]) -> str:
    label = display_label(match)
    entry = match_entry_price(match)
    if entry is None:
        return label
    return f"{label} @ {format_price(entry)}"


def format_price(value: Any) -> str:
    try:
        return f"{float(value):.2f}"
    except (TypeError, ValueError):
        return str(value)


def mtf_signature(quotes: list[dict[str, Any]]) -> str:
    return ",".join(
        sorted(
            f"{quote.get('symbol')}:{'|'.join(mtf_match_signature(match) for match in quote.get('mtf_matches', []))}"
            for quote in quotes
        )
    )


def mtf_match_signature(match: dict[str, Any]) -> str:
    return "|".join(
        str(match.get(key) or "")
        for key in ("label", "display_label", "mtf_label", "candle_time", "entry_price")
    )
