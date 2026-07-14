import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.config import Settings


POST_MARKET_CLOSE_MINUTES = 19 * 60


def live_data_timezone(settings: Settings) -> ZoneInfo | None:
    try:
        return ZoneInfo(settings.mtf_push_timezone)
    except ZoneInfoNotFoundError:
        return None


def market_now(settings: Settings) -> datetime:
    timezone = live_data_timezone(settings)
    return datetime.now(timezone) if timezone else datetime.now()


def manual_unlock_for_today(settings: Settings) -> dict[str, str]:
    now = market_now(settings)
    payload = {
        "date": now.date().isoformat(),
        "unlocked_at": now.isoformat(),
    }
    write_unlock(settings.live_data_unlock_file, payload)
    return payload


def is_live_data_unlocked_today(settings: Settings, now: datetime | None = None) -> bool:
    now = now or market_now(settings)
    if now.weekday() >= 5:
        return False
    minutes = now.hour * 60 + now.minute
    if minutes >= POST_MARKET_CLOSE_MINUTES:
        return False
    payload = read_unlock(settings.live_data_unlock_file)
    return payload.get("date") == now.date().isoformat()


def read_unlock(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def write_unlock(path: Path, payload: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
