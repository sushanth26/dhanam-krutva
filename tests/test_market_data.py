from datetime import datetime, timedelta

from app.market_data import aggregate_by_minutes, ema_touch_matches, ema_values, mtf_matches, parse_symbols


def candle(index: int, close: float) -> dict:
    stamp = datetime(2026, 7, 2, 9, 30) + timedelta(minutes=5 * index)
    return {
        "time": stamp.isoformat(),
        "sort_time": stamp.isoformat(),
        "open": close - 0.5,
        "high": close + 1,
        "low": close - 1,
        "close": close,
        "volume": 100 + index,
    }


def test_parse_symbols_normalizes_and_filters_empty_entries():
    assert parse_symbols(" be, AAOI ,,lly ") == ["BE", "AAOI", "LLY"]


def test_aggregate_by_minutes_rolls_5m_bars_into_10m_buckets():
    candles = [candle(0, 10), candle(1, 11), candle(2, 12), candle(3, 13)]

    aggregated = aggregate_by_minutes(candles, 10)

    assert len(aggregated) == 2
    assert aggregated[0]["open"] == 9.5
    assert aggregated[0]["close"] == 11
    assert aggregated[0]["high"] == 12
    assert aggregated[0]["low"] == 9
    assert aggregated[0]["volume"] == 201
    assert aggregated[0]["source_count"] == 2


def test_ema_values_returns_latest_values_by_period():
    candles = [candle(index, float(index + 1)) for index in range(12)]

    values = ema_values(candles, [5, 12, 20])

    assert values["5"] is not None
    assert values["12"] is not None
    assert values["20"] is None


def test_mtf_matches_detects_price_inside_cloud_ranges():
    matches = mtf_matches(
        105,
        {"34": 100, "50": 110},
        {"20": 80, "21": 90, "50": 104, "55": 106},
    )

    assert [match["label"] for match in matches] == ["Hourly 34/50", "Daily 50/55"]


def test_ema_touch_matches_alerts_when_10m_candle_closes_back_above_tracked_emas():
    candles = [
        {"low": 93, "close": 97},
        {"low": 99, "close": 103},
    ]

    matches = ema_touch_matches(
        candles,
        {"5": 101, "12": 102, "34": 100, "50": 110},
        {"34": 98, "50": 101},
        {"20": 102, "21": 103, "50": 104, "55": 105},
    )

    assert [match["label"] for match in matches] == [
        "10m touch 34",
        "10m touch Hourly 50",
        "10m touch Daily 20",
    ]
    assert all(match["type"] == "10m_touch" for match in matches)


def test_ema_touch_matches_ignores_5_and_12_emas():
    matches = ema_touch_matches(
        [{"low": 99, "close": 103}],
        {"5": 100, "12": 101, "34": 110, "50": 111},
        {"34": 112, "50": 113},
        {"20": 114, "21": 115, "50": 116, "55": 117},
    )

    assert matches == []


def test_ema_touch_matches_uses_latest_complete_10m_candle():
    matches = ema_touch_matches(
        [
            {"low": 99, "close": 103, "source_count": 2},
            {"low": 89, "close": 93, "source_count": 1},
        ],
        {"34": 100, "50": 110},
        {"34": 111, "50": 112},
        {"20": 113, "21": 114, "50": 115, "55": 116},
    )

    assert [match["label"] for match in matches] == ["10m touch 34"]
