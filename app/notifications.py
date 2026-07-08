import asyncio
import json
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pywebpush import WebPushException, webpush

from app.config import Settings
from app.dependencies import service
from app.market_data import WEBULL_BATCH_BAR_LIMIT, build_live_prices, symbol_chunks
from app.watchlists import WatchlistStore


DEFAULT_ALERT_STRATEGIES = {
    "hourly-cloud": True,
    "daily-fast-cloud": True,
    "daily-slow-cloud": True,
    "ten-minute-bounce-10m": True,
    "ten-minute-9ema-touch": True,
    "ten-minute-bounce-hourly": True,
    "ten-minute-bounce-daily-fast": True,
    "ten-minute-bounce-daily-slow": True,
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
        quotes = confirmed_mtf_quotes(build_monitored_quotes(self.settings))
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
    webull = service()
    for chunk in symbol_chunks(monitored_symbols(settings), WEBULL_BATCH_BAR_LIMIT):
        if not chunk:
            continue
        payload = build_live_prices(webull, ",".join(chunk))
        quotes.extend(payload.get("quotes", []))
    return quotes


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


def confirmed_mtf_quotes(quotes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    output = []
    for quote in quotes:
        matches = [
            match
            for match in quote.get("mtf_matches", [])
            if match.get("status", "confirmed") == "confirmed"
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
            "title": "No MTF alerts",
            "body": "No symbols are on MTF clouds now.",
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
            "body": " + ".join(labels[1:]) if len(labels) > 1 else "Tap to open this MTF row.",
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
        "title": f"{len(matches)} MTF alerts: {symbol_text}",
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
            f"{quote.get('symbol')}:{'|'.join(match.get('label', '') for match in quote.get('mtf_matches', []))}"
            for quote in quotes
        )
    )


def strategy_id_for_label(label: str) -> str:
    if label == "10m bounce 34/50":
        return "ten-minute-bounce-10m"
    if label == "10m 9 EMA touch":
        return "ten-minute-9ema-touch"
    if label == "10m bounce Hourly 34/50":
        return "ten-minute-bounce-hourly"
    if label == "10m bounce Daily 20/21":
        return "ten-minute-bounce-daily-fast"
    if label == "10m bounce Daily 50/55":
        return "ten-minute-bounce-daily-slow"
    if label == "Hourly 34/50":
        return "hourly-cloud"
    if label == "Daily 20/21":
        return "daily-fast-cloud"
    if label == "Daily 50/55":
        return "daily-slow-cloud"
    return "unknown"


def normalize_strategy_state(strategy_state: dict[str, Any] | None) -> dict[str, bool]:
    normalized = DEFAULT_ALERT_STRATEGIES.copy()
    if isinstance(strategy_state, dict):
        legacy_bounce = strategy_state.get("ten-minute-bounce", strategy_state.get("ten-minute-touch"))
        if legacy_bounce is not None:
            for key in (
                "ten-minute-bounce-10m",
                "ten-minute-bounce-hourly",
                "ten-minute-bounce-daily-fast",
                "ten-minute-bounce-daily-slow",
            ):
                if key not in strategy_state:
                    normalized[key] = bool(legacy_bounce)
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
        details = []
        detail_by_label = {
            str(detail.get("label") or ""): detail
            for detail in item.get("details", [])
            if isinstance(detail, dict)
        }
        for label in item.get("labels", []):
            label_text = str(label or "")
            if label_text and strategies.get(strategy_id_for_label(label_text), True):
                labels.append(label_text)
                if label_text in detail_by_label:
                    details.append(detail_by_label[label_text])
        if labels:
            filtered_matches.append({"symbol": item.get("symbol"), "labels": labels, "details": details})

    if not filtered_matches:
        return None

    notification = mtf_notification_details([
        {
            "symbol": item.get("symbol"),
            "mtf_matches": [
                item.get("details", [])[index]
                if index < len(item.get("details", []))
                else {"label": label}
                for index, label in enumerate(item.get("labels", []))
            ],
        }
        for item in filtered_matches
    ])
    return {
        **payload,
        "title": notification["title"],
        "body": notification["body"],
        "badgeCount": len(filtered_matches),
        "badge_count": len(filtered_matches),
        "tag": notification["tag"],
        "targetSymbol": notification["target_symbol"],
        "url": notification["url"],
        "matches": filtered_matches,
    }
