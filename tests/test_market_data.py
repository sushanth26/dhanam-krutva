from datetime import datetime, timedelta

from app.market_data import aggregate_by_minutes, ema_values, mtf_matches, parse_symbols


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
