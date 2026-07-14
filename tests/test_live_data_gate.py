from datetime import datetime
from types import SimpleNamespace
from zoneinfo import ZoneInfo

from app.live_data_gate import is_live_data_unlocked_today, write_unlock
from app.notifications import is_market_refresh_window


def test_live_data_unlock_matches_current_market_day(tmp_path):
    settings = SimpleNamespace(
        live_data_unlock_file=tmp_path / "live-data-unlock.json",
        mtf_push_timezone="America/Chicago",
    )
    now = datetime(2026, 7, 13, 9, 30, tzinfo=ZoneInfo("America/Chicago"))

    write_unlock(settings.live_data_unlock_file, {"date": "2026-07-13", "unlocked_at": now.isoformat()})

    assert is_live_data_unlocked_today(settings, now) is True


def test_live_data_unlock_expires_after_postmarket_close(tmp_path):
    settings = SimpleNamespace(
        live_data_unlock_file=tmp_path / "live-data-unlock.json",
        mtf_push_timezone="America/Chicago",
    )
    now = datetime(2026, 7, 13, 19, 0, tzinfo=ZoneInfo("America/Chicago"))

    write_unlock(settings.live_data_unlock_file, {"date": "2026-07-13", "unlocked_at": now.isoformat()})

    assert is_live_data_unlocked_today(settings, now) is False


def test_market_refresh_window_runs_until_postmarket_close():
    assert is_market_refresh_window("America/Chicago", datetime(2026, 7, 13, 18, 59, tzinfo=ZoneInfo("America/Chicago"))) is True
    assert is_market_refresh_window("America/Chicago", datetime(2026, 7, 13, 19, 0, tzinfo=ZoneInfo("America/Chicago"))) is False
