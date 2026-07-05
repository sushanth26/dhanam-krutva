import json
import re
from pathlib import Path
from typing import Any

from app.market_data import LIVE_WATCHLIST


OG_WATCHLIST_ID = "og"


def default_watchlists() -> list[dict[str, Any]]:
    return [
        {
            "id": OG_WATCHLIST_ID,
            "name": "OG list",
            "symbols": LIVE_WATCHLIST,
            "locked": True,
        }
    ]


class WatchlistStore:
    def __init__(self, path: Path):
        self.path = path

    def all(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return default_watchlists()
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return default_watchlists()
        if isinstance(data, dict):
            data = data.get("watchlists")
        return normalize_watchlists(data if isinstance(data, list) else [])

    def replace(self, watchlists: list[dict[str, Any]]) -> list[dict[str, Any]]:
        normalized = normalize_watchlists(watchlists)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(normalized, indent=2), encoding="utf-8")
        return normalized


def normalize_watchlists(watchlists: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    used_ids: set[str] = set()
    for item in watchlists:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "Watchlist").strip() or "Watchlist"
        base_id = OG_WATCHLIST_ID if item.get("id") == OG_WATCHLIST_ID else slugify(str(item.get("id") or name))
        watchlist_id = unique_id(base_id, used_ids)
        used_ids.add(watchlist_id)
        normalized.append(
            {
                "id": watchlist_id,
                "name": "OG list" if watchlist_id == OG_WATCHLIST_ID else name,
                "symbols": normalize_symbols(item.get("symbols", []))[:25],
                "locked": watchlist_id == OG_WATCHLIST_ID,
            }
        )
    if not any(item["id"] == OG_WATCHLIST_ID for item in normalized):
        normalized.insert(0, default_watchlists()[0])
    return normalized


def normalize_symbols(value: Any) -> list[str]:
    if not isinstance(value, list):
        value = [value]
    symbols: list[str] = []
    seen: set[str] = set()
    for item in value:
        for part in re.split(r"[\s,]+", str(item or "")):
            symbol = part.strip().upper()
            if symbol and symbol not in seen:
                symbols.append(symbol)
                seen.add(symbol)
    return symbols


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "watchlist"


def unique_id(base_id: str, used_ids: set[str]) -> str:
    watchlist_id = base_id or "watchlist"
    index = 2
    while watchlist_id in used_ids:
        watchlist_id = f"{base_id}-{index}"
        index += 1
    return watchlist_id
