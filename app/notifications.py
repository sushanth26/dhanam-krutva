import asyncio
import json
from datetime import UTC, datetime
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
    "ten-minute-40ema-touch": True,
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


class AlertHistoryStore:
    def __init__(self, path: Path, max_items: int = 1000):
        self.path = path
        self.max_items = max_items

    def all(self, limit: int | None = None) -> list[dict[str, Any]]:
        items = self._read()
        if limit is None:
            return items
        return items[: max(0, limit)]

    def append(self, entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
        normalized_entries = [normalize_alert_history_entry(entry) for entry in entries if isinstance(entry, dict)]
        if not normalized_entries:
            return self.all()

        current = self._read()
        seen = {str(item.get("id") or "") for item in normalized_entries}
        merged = normalized_entries + [item for item in current if str(item.get("id") or "") not in seen]
        merged = sorted(merged, key=alert_history_sort_key, reverse=True)[: self.max_items]
        self._write(merged)
        return merged

    def clear(self) -> None:
        self._write([])

    def _read(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        if isinstance(data, dict):
            data = data.get("items", [])
        if not isinstance(data, list):
            return []
        return [normalize_alert_history_entry(item) for item in data if isinstance(item, dict)]

    def _write(self, items: list[dict[str, Any]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(items, indent=2), encoding="utf-8")


class MtfPushMonitor:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.store = PushSubscriptionStore(settings.push_subscription_file)
        self.task: asyncio.Task | None = None
        self.last_signature: str | None = None
        self.last_bos_state: dict[str, dict[str, Any]] | None = None
        self.paused_for_manual_retry = False
        self.last_error: str | None = None

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
                    not self.paused_for_manual_retry
                    and self.store.all()
                    and is_market_refresh_window(self.settings.mtf_push_timezone)
                ):
                    await asyncio.to_thread(self.check_once)
            except Exception:
                pass
            await asyncio.sleep(self.settings.mtf_push_poll_seconds)

    def check_once(self, manual: bool = False) -> dict[str, Any] | None:
        if self.paused_for_manual_retry and not manual:
            return None
        if manual:
            self.paused_for_manual_retry = False
            self.last_error = None
        try:
            quotes = build_monitored_quotes(self.settings)
            mtf_quotes = confirmed_mtf_quotes(quotes)
            signature = mtf_signature(mtf_quotes)
            changed = self.last_signature is not None and signature != self.last_signature
            self.last_signature = signature
            next_bos_state, bos_changes = bos_state_changes(self.last_bos_state, quotes)
            self.last_bos_state = next_bos_state
            self.last_error = None
            notifications = []
            if changed:
                notifications.append(mtf_notification_payload(mtf_quotes))
            if bos_changes:
                notifications.append(bos_notification_payload(bos_changes))
            if not notifications:
                return None

            history = AlertHistoryStore(self.settings.alert_history_file)
            for notification in notifications:
                history.append(alert_history_entries_from_push(notification))
                self.send(notification)
            return notifications[0] if len(notifications) == 1 else {"ok": True, "notifications": notifications}
        except Exception as exc:
            self.paused_for_manual_retry = True
            self.last_error = str(exc)
            raise

    def status(self) -> dict[str, Any]:
        return {
            "paused_for_manual_retry": self.paused_for_manual_retry,
            "last_error": self.last_error,
        }

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


def is_market_refresh_window(timezone_name: str, now: datetime | None = None) -> bool:
    try:
        current = now.astimezone(ZoneInfo(timezone_name)) if now else datetime.now(ZoneInfo(timezone_name))
    except ZoneInfoNotFoundError:
        current = now or datetime.now()
    if current.weekday() >= 5:
        return False
    minutes = current.hour * 60 + current.minute
    return 3 * 60 <= minutes < 18 * 60


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
        if payload.get("ok") is False:
            first_error = next((item.get("error") for item in payload.get("errors", []) if item.get("error")), None)
            raise RuntimeError(webull_error_message(first_error or payload))
        quotes.extend(payload.get("quotes", []))
    return quotes


def bos_state_from_quotes(quotes: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    state = {}
    for quote in quotes:
        symbol = str(quote.get("symbol") or "").upper()
        structure = quote.get("structure_10m") if isinstance(quote.get("structure_10m"), dict) else {}
        status = str(structure.get("status") or "Unknown")
        if not symbol or not is_monitorable_bos_status(status):
            continue
        state[symbol] = {
            "status": status,
            "structure_time": structure.get("time") or "",
        }
    return state


def bos_state_changes(
    previous_state: dict[str, dict[str, Any]] | None,
    quotes: list[dict[str, Any]],
) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    next_state = bos_state_from_quotes(quotes)
    if previous_state is None:
        return next_state, []

    changes = []
    for symbol, current in next_state.items():
        previous = previous_state.get(symbol)
        if not previous or previous.get("status") == current.get("status"):
            continue
        changes.append(
            {
                "symbol": symbol,
                "previous_status": previous.get("status"),
                "status": current.get("status"),
                "structure_time": current.get("structure_time") or "",
            }
        )
    return next_state, changes


def is_monitorable_bos_status(status: str) -> bool:
    return status in {"Bullish BOS", "Bearish BOS", "Chop"}


def bos_label(status: Any) -> str:
    text = str(status or "Unknown")
    if text == "Bullish BOS":
        return "Bull BOS"
    if text == "Bearish BOS":
        return "Bear BOS"
    return text


def bos_notification_payload(changes: list[dict[str, Any]]) -> dict[str, Any]:
    target_symbol = str(changes[0].get("symbol") or "").upper() if changes else ""
    if len(changes) == 1:
        change = changes[0]
        symbol = str(change.get("symbol") or "").upper()
        status = bos_label(change.get("status"))
        previous_status = bos_label(change.get("previous_status"))
        return {
            "title": f"{symbol}: {status}",
            "body": f"BOS changed from {previous_status} to {status}.",
            "badgeCount": 1,
            "badge_count": 1,
            "tag": f"bos-{symbol}",
            "targetSymbol": symbol,
            "target_symbol": symbol,
            "url": "/#alerts",
            "changes": changes,
        }

    preview = " | ".join(f"{change.get('symbol')} {bos_label(change.get('status'))}" for change in changes[:3])
    if len(changes) > 3:
        preview += "..."
    return {
        "title": f"{len(changes)} BOS changes",
        "body": preview,
        "badgeCount": len(changes),
        "badge_count": len(changes),
        "tag": "bos-batch",
        "targetSymbol": target_symbol,
        "target_symbol": target_symbol,
        "url": "/#alerts",
        "changes": changes,
    }


def webull_error_message(error: Any) -> str:
    if isinstance(error, dict):
        if error.get("webull_guard_active"):
            blocked_until = error.get("webull_guard_blocked_until")
            suffix = f" until {blocked_until}" if blocked_until else ""
            return f"Webull calls are paused{suffix}: {error.get('error') or error.get('message') or 'manual retry required'}"
        return str(error.get("error") or error.get("message") or error.get("error_code") or "Webull request failed")
    return str(error or "Webull request failed")


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


def alert_history_entries_from_push(payload: dict[str, Any]) -> list[dict[str, Any]]:
    created_at = datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
    title = str(payload.get("title") or "Push notification")
    body = str(payload.get("body") or "")
    matches = payload.get("matches", [])
    target_symbol = str(payload.get("targetSymbol") or payload.get("target_symbol") or "").upper()
    if not target_symbol and matches:
        target_symbol = str(matches[0].get("symbol") or "").upper()
    return [
        {
            "id": f"{created_at}:push:{payload.get('tag') or title}",
            "createdAt": created_at,
            "alertedAt": created_at,
            "kind": "push",
            "source": "server-push",
            "title": title,
            "body": body,
            "symbol": target_symbol,
            "reason": body or title,
            "payload": payload,
            "status": "triggered",
        }
    ]


def normalize_alert_history_entry(entry: dict[str, Any]) -> dict[str, Any]:
    created_at = str(
        entry.get("createdAt")
        or entry.get("created_at")
        or entry.get("alertedAt")
        or datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
    )
    title = str(entry.get("title") or entry.get("reason") or entry.get("label") or "Alert triggered")
    body = str(entry.get("body") or entry.get("message") or entry.get("reason") or "")
    symbol = str(entry.get("symbol") or "").upper()
    normalized = {
        **entry,
        "id": str(entry.get("id") or f"{created_at}:{symbol}:{title}"),
        "createdAt": created_at,
        "alertedAt": str(entry.get("alertedAt") or created_at),
        "kind": str(entry.get("kind") or "alert"),
        "title": title,
        "body": body,
        "symbol": symbol,
        "reason": str(entry.get("reason") or body or title),
        "status": str(entry.get("status") or "triggered"),
    }
    normalized.pop("created_at", None)
    return normalized


def alert_history_sort_key(item: dict[str, Any]) -> str:
    return str(item.get("alertedAt") or item.get("createdAt") or "")


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
    if label == "10m 40 EMA touch":
        return "ten-minute-40ema-touch"
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

    strategies = strategy_state if isinstance(strategy_state, dict) else {}
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
            if label_text and strategies.get(strategy_id_for_label(label_text)) is True:
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
