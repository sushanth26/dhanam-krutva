import json
from pathlib import Path
from typing import Any


ALERT_STRATEGIES = [
    {"key": "scannerEntry", "match_types": ["scanner_entry"]},
    {"key": "curls", "match_types": ["long_mtf_5_12_touch"]},
    {"key": "tenMinute3450Bounce", "match_types": ["10m_34_50_bounce"]},
    {"key": "mtfCloudTouch", "match_types": ["mtf_cloud_price_touch"]},
]

MATCH_TYPE_TO_STRATEGY_KEY = {
    match_type: strategy["key"]
    for strategy in ALERT_STRATEGIES
    for match_type in strategy["match_types"]
}


def default_alert_strategies() -> dict[str, bool]:
    return {strategy["key"]: True for strategy in ALERT_STRATEGIES}


class AlertStrategySettingsStore:
    def __init__(self, path: Path):
        self.path = path

    def get(self) -> dict[str, bool]:
        defaults = default_alert_strategies()
        if not self.path.exists():
            return defaults
        try:
            saved = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return defaults
        if not isinstance(saved, dict):
            return defaults
        return {**defaults, **{key: bool(value) for key, value in saved.items() if key in defaults}}

    def save(self, strategies: dict[str, Any]) -> dict[str, bool]:
        merged = {**self.get(), **{key: bool(value) for key, value in strategies.items() if key in default_alert_strategies()}}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(merged, indent=2), encoding="utf-8")
        return merged


def match_enabled(match: dict[str, Any], strategies: dict[str, bool]) -> bool:
    key = MATCH_TYPE_TO_STRATEGY_KEY.get(match.get("type"))
    if key is None:
        return True
    return strategies.get(key, True)


def filter_enabled_matches(matches: list[dict[str, Any]], strategies: dict[str, bool]) -> list[dict[str, Any]]:
    return [match for match in matches if match_enabled(match, strategies)]
