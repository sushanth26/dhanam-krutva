import json
from pathlib import Path
from typing import Any


class AlertHistoryStore:
    def __init__(self, path: Path):
        self.path = path

    def all(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        alerts = data.get("alerts") if isinstance(data, dict) else data
        return alerts if isinstance(alerts, list) else []

    def upsert_many(self, alerts: list[dict[str, Any]]) -> list[dict[str, Any]]:
        existing = self.all()
        by_id = {alert_id(item): item for item in existing if alert_id(item)}
        ordered_ids = [alert_id(item) for item in existing if alert_id(item)]

        for alert in alerts:
            normalized = normalize_alert(alert)
            key = alert_id(normalized)
            if not key:
                continue
            if key not in by_id:
                ordered_ids.append(key)
            by_id[key] = {**by_id.get(key, {}), **normalized}

        merged = [by_id[key] for key in ordered_ids if key in by_id]
        self._write(merged)
        return merged

    def _write(self, alerts: list[dict[str, Any]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps({"alerts": alerts}, indent=2), encoding="utf-8")


def normalize_alert(alert: dict[str, Any]) -> dict[str, Any]:
    match = alert.get("match") if isinstance(alert.get("match"), dict) else {}
    quote = alert.get("quote") if isinstance(alert.get("quote"), dict) else {}
    watchlist = alert.get("watchlist") if isinstance(alert.get("watchlist"), dict) else {}
    symbol = str(alert.get("symbol") or quote.get("symbol") or "").upper()
    return {
        **alert,
        "id": alert.get("id") or alert_signature(symbol, match, watchlist),
        "symbol": symbol,
        "quote": {**quote, "symbol": symbol},
        "watchlist": watchlist,
        "match": match,
    }


def alert_id(alert: dict[str, Any]) -> str:
    return str(alert.get("id") or "").strip()


def alert_signature(symbol: str, match: dict[str, Any], watchlist: dict[str, Any]) -> str:
    parts = [
        symbol,
        str(watchlist.get("id") or ""),
        str(match.get("type") or ""),
        str(match.get("display_label") or match.get("label") or ""),
        str(match.get("candle_time") or ""),
        str(match.get("mtf_label") or match.get("cloud_label") or ""),
    ]
    return "|".join(parts)
