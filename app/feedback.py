"""Worked / failed / choppy marks on bounce alerts, saved with a copy of the alert for later review."""
import json
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

VERDICTS = ("worked", "failed", "choppy")

_lock = threading.Lock()


class FeedbackStore:
    def __init__(self, path: str | Path):
        self.path = Path(path)

    def all(self) -> dict[str, dict[str, Any]]:
        with _lock:
            return self._read()

    def verdicts(self) -> dict[str, str]:
        return {alert_id: item["verdict"] for alert_id, item in self.all().items()}

    def mark(self, alert: dict[str, Any], verdict: str | None) -> dict[str, dict[str, Any]]:
        """Set (or clear, with None) the verdict for one alert. The alert snapshot is kept so the
        mark still makes sense after the live alert list has rolled over."""
        alert_id = str(alert.get("id") or "")
        if not alert_id:
            raise ValueError("alert id missing")
        if verdict is not None and verdict not in VERDICTS:
            raise ValueError(f"verdict must be one of {', '.join(VERDICTS)}")
        with _lock:
            items = self._read()
            if verdict is None:
                items.pop(alert_id, None)
            else:
                snapshot = {key: value for key, value in alert.items() if key != "verdict"}
                items[alert_id] = {"verdict": verdict, "marked_at": datetime.now(UTC).isoformat(), "alert": snapshot}
            self._write(items)
            return items

    def _read(self) -> dict[str, dict[str, Any]]:
        if not self.path.exists():
            return {}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return data if isinstance(data, dict) else {}

    def _write(self, items: dict[str, dict[str, Any]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(items, indent=2), encoding="utf-8")
        tmp.replace(self.path)
