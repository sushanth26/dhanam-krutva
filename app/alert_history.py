import json
import sqlite3
from pathlib import Path
from typing import Any


class AlertHistoryStore:
    def __init__(self, path: Path):
        self.path = path
        self._migrate_json_history()
        self._ensure_schema()

    def all(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT payload FROM mtf_alerts ORDER BY alerted_at DESC, created_at DESC"
            ).fetchall()
        return [json.loads(row["payload"]) for row in rows]

    def upsert_many(self, alerts: list[dict[str, Any]]) -> list[dict[str, Any]]:
        normalized_alerts = [normalize_alert(alert) for alert in alerts]
        with self._connect() as connection:
            for alert in normalized_alerts:
                key = alert_id(alert)
                if not key:
                    continue
                connection.execute(
                    """
                    INSERT INTO mtf_alerts (id, symbol, setup_type, alerted_at, created_at, payload)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        symbol = excluded.symbol,
                        setup_type = excluded.setup_type,
                        alerted_at = excluded.alerted_at,
                        created_at = excluded.created_at,
                        payload = excluded.payload
                    """,
                    (
                        key,
                        alert.get("symbol") or "",
                        alert.get("match", {}).get("type") or "",
                        alert_timestamp(alert),
                        alert.get("created_at") or alert_timestamp(alert),
                        json.dumps(alert, separators=(",", ":")),
                    ),
                )
        return self.all()

    def delete(self, alert_id_value: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            connection.execute("DELETE FROM mtf_alerts WHERE id = ?", (alert_id_value,))
        return self.all()

    def delete_all(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            connection.execute("DELETE FROM mtf_alerts")
        return []

    def _connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        return connection

    def _ensure_schema(self) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS mtf_alerts (
                    id TEXT PRIMARY KEY,
                    symbol TEXT NOT NULL,
                    setup_type TEXT NOT NULL,
                    alerted_at TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    payload TEXT NOT NULL
                )
                """
            )
            connection.execute("CREATE INDEX IF NOT EXISTS idx_mtf_alerts_alerted_at ON mtf_alerts(alerted_at)")
            connection.execute("CREATE INDEX IF NOT EXISTS idx_mtf_alerts_symbol ON mtf_alerts(symbol)")

    def _migrate_json_history(self) -> None:
        if self.path.suffix != ".sqlite3" or self.path.exists():
            return
        legacy_path = self.path.with_suffix(".json")
        if not legacy_path.exists():
            return
        try:
            data = json.loads(legacy_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        alerts = data.get("alerts") if isinstance(data, dict) else data
        if not isinstance(alerts, list):
            return
        self._ensure_schema()
        self.upsert_many(alerts)


def normalize_alert(alert: dict[str, Any]) -> dict[str, Any]:
    match = alert.get("match") if isinstance(alert.get("match"), dict) else {}
    quote = alert.get("quote") if isinstance(alert.get("quote"), dict) else {}
    watchlist = alert.get("watchlist") if isinstance(alert.get("watchlist"), dict) else {}
    symbol = str(alert.get("symbol") or quote.get("symbol") or "").upper()
    normalized = {
        **alert,
        "symbol": symbol,
        "quote": {**quote, "symbol": symbol},
        "watchlist": watchlist,
        "match": match,
    }
    return {
        **normalized,
        "id": alert.get("id") or alert_signature(symbol, match, watchlist),
    }


def alert_id(alert: dict[str, Any]) -> str:
    return str(alert.get("id") or "").strip()


def alert_timestamp(alert: dict[str, Any]) -> str:
    match = alert.get("match") if isinstance(alert.get("match"), dict) else {}
    return str(match.get("candle_time") or alert.get("created_at") or "")


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
