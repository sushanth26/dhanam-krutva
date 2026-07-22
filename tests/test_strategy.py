import os
import time

from app.strategy import parse_time, session_date


def test_parse_time_uses_market_timezone_for_numeric_timestamps(monkeypatch):
    original_tz = os.environ.get("TZ")
    monkeypatch.setenv("TZ", "UTC")
    if hasattr(time, "tzset"):
        time.tzset()

    try:
        assert parse_time("1784764800000") == "2026-07-22T20:00:00-04:00"
        assert session_date("1784764800000") == "2026-07-22"
    finally:
        restore_tz(monkeypatch, original_tz)


def test_parse_time_converts_offset_timestamps_to_market_timezone(monkeypatch):
    original_tz = os.environ.get("TZ")
    monkeypatch.setenv("TZ", "UTC")
    if hasattr(time, "tzset"):
        time.tzset()

    try:
        assert parse_time("2026-07-23T00:20:00.000+00:00") == "2026-07-22T20:20:00-04:00"
        assert session_date("2026-07-23T00:20:00.000+00:00") == "2026-07-22"
    finally:
        restore_tz(monkeypatch, original_tz)


def test_parse_time_treats_naive_iso_timestamps_as_market_time(monkeypatch):
    original_tz = os.environ.get("TZ")
    monkeypatch.setenv("TZ", "UTC")
    if hasattr(time, "tzset"):
        time.tzset()

    try:
        assert parse_time("2026-07-22T09:30:00") == "2026-07-22T09:30:00-04:00"
        assert session_date("2026-07-22T09:30:00") == "2026-07-22"
    finally:
        restore_tz(monkeypatch, original_tz)


def restore_tz(monkeypatch, value):
    if value is None:
        monkeypatch.delenv("TZ", raising=False)
    else:
        monkeypatch.setenv("TZ", value)
    if hasattr(time, "tzset"):
        time.tzset()
