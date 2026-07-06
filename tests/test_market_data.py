from datetime import datetime, timedelta

from app.market_data import (
    LIVE_WATCHLIST,
    aggregate_by_minutes,
    batch_history_bars_chunked,
    ema_cloud_bounce_matches,
    ema_values,
    mtf_matches,
    mtf_signal_matches,
    parse_symbols,
    symbol_chunks,
)


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


def test_live_watchlist_includes_new_og_symbols_under_webull_limit():
    for symbol in ["APLD", "CIFR", "CRWV", "HUT", "IREN", "NBIS", "WULF"]:
        assert symbol in LIVE_WATCHLIST
    assert len(LIVE_WATCHLIST) <= 25


def test_symbol_chunks_splits_bar_requests_at_webull_limit():
    symbols = [f"S{index}" for index in range(24)]

    chunks = symbol_chunks(symbols, 20)

    assert [len(chunk) for chunk in chunks] == [20, 4]
    assert chunks[0][0] == "S0"
    assert chunks[1][-1] == "S23"


def test_batch_history_bars_chunked_merges_results():
    class FakeWebull:
        def __init__(self):
            self.calls = []

        def batch_history_bars(self, symbols, category, timespan, count, real_time_required=True, trading_sessions=None):
            self.calls.append(list(symbols))
            return {
                "ok": True,
                "data": {
                    "result": [
                        {"symbol": symbol, "result": [{"close": index}]}
                        for index, symbol in enumerate(symbols)
                    ]
                },
            }

    webull = FakeWebull()
    symbols = [f"S{index}" for index in range(24)]

    response = batch_history_bars_chunked(webull, symbols, "US_STOCK", "M5", count="1200")

    assert [len(call) for call in webull.calls] == [20, 4]
    assert response["ok"] is True
    assert [item["symbol"] for item in response["data"]["result"]] == symbols


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


def test_mtf_signal_matches_skips_chop_trend():
    matches = mtf_signal_matches(
        105,
        "Chop",
        [{"low": 99, "close": 113}],
        {"5": 101, "12": 102, "34": 100, "50": 110},
        {"34": 100, "50": 110},
        {"20": 80, "21": 90, "50": 104, "55": 106},
    )

    assert matches == []


def test_mtf_signal_matches_keeps_bullish_or_bearish_trend():
    matches = mtf_signal_matches(
        105,
        "Bullish",
        [{"low": 99, "close": 113, "time": "2026-07-02T09:40:00"}],
        {"5": 116, "12": 114, "34": 100, "50": 110},
        {"34": 100, "50": 110},
        {"20": 80, "21": 90, "50": 104, "55": 106},
    )

    assert [match["label"] for match in matches][:2] == ["Hourly 34/50", "Daily 50/55"]
    assert matches[0]["status"] == "confirmed"
    assert matches[0]["candle_time"] == "2026-07-02T09:40:00"
    assert matches[1]["candle_time"] == "2026-07-02T09:40:00"


def test_mtf_signal_matches_marks_incomplete_10m_candle_as_waiting():
    matches = mtf_signal_matches(
        105,
        "Bullish",
        [{"low": 99, "close": 113, "source_count": 1, "time": "2026-07-02T09:40:00"}],
        {"5": 116, "12": 114, "34": 100, "50": 110},
        {"34": 100, "50": 110},
        {"20": 80, "21": 90, "50": 104, "55": 106},
    )

    assert [match["label"] for match in matches][:2] == ["Hourly 34/50", "Daily 50/55"]
    assert all(match["status"] == "waiting" for match in matches)
    assert matches[0]["candle_time"] == "2026-07-02T09:40:00"


def test_ema_cloud_bounce_matches_alerts_when_10m_candle_closes_back_above_clouds():
    candles = [
        {"low": 93, "close": 97},
        {"low": 99, "close": 112},
    ]

    matches = ema_cloud_bounce_matches(
        candles,
        {"5": 101, "12": 102, "34": 100, "50": 110},
        {"34": 98, "50": 101},
        {"20": 102, "21": 103, "50": 104, "55": 105},
    )

    assert [match["label"] for match in matches] == [
        "10m bounce 34/50",
        "10m bounce Hourly 34/50",
        "10m bounce Daily 20/21",
        "10m bounce Daily 50/55",
    ]
    assert all(match["type"] == "10m_cloud_bounce" for match in matches)
    assert matches[0]["trend"] == "Chop"
    assert matches[0]["candle_time"] is None


def test_ema_cloud_bounce_matches_ignores_5_and_12_cloud():
    matches = ema_cloud_bounce_matches(
        [{"low": 99, "close": 103}],
        {"5": 100, "12": 101, "34": 110, "50": 111},
        {"34": 112, "50": 113},
        {"20": 114, "21": 115, "50": 116, "55": 117},
    )

    assert matches == []


def test_ema_cloud_bounce_marks_10m_34_50_bullish_trend():
    matches = ema_cloud_bounce_matches(
        [{"low": 99, "close": 113}],
        {"5": 116, "12": 114, "34": 100, "50": 110},
        {"34": 120, "50": 121},
        {"20": 122, "21": 123, "50": 124, "55": 125},
    )

    assert matches[0]["label"] == "10m bounce 34/50"
    assert matches[0]["trend"] == "Bullish"


def test_ema_cloud_bounce_marks_10m_34_50_bearish_trend():
    matches = ema_cloud_bounce_matches(
        [{"low": 99, "close": 113}],
        {"5": 90, "12": 95, "34": 100, "50": 110},
        {"34": 120, "50": 121},
        {"20": 122, "21": 123, "50": 124, "55": 125},
    )

    assert matches[0]["label"] == "10m bounce 34/50"
    assert matches[0]["trend"] == "Bearish"


def test_ema_cloud_bounce_matches_uses_latest_10m_candle_not_previous_complete():
    matches = ema_cloud_bounce_matches(
        [
            {"low": 99, "close": 113, "source_count": 2, "time": "2026-07-02T09:40:00"},
            {"low": 89, "close": 93, "source_count": 1, "time": "2026-07-02T09:50:00"},
        ],
        {"34": 100, "50": 110},
        {"34": 120, "50": 121},
        {"20": 122, "21": 123, "50": 124, "55": 125},
    )

    assert matches == []


def test_mtf_signal_matches_waits_on_incomplete_10m_bounce():
    matches = mtf_signal_matches(
        125,
        "Bullish",
        [{"low": 99, "close": 113, "source_count": 1, "time": "2026-07-02T09:50:00"}],
        {"5": 116, "12": 114, "34": 100, "50": 110},
        {"34": 120, "50": 121},
        {"20": 122, "21": 123, "50": 124, "55": 125},
    )

    assert [match["label"] for match in matches] == ["Daily 50/55", "10m bounce 34/50"]
    assert all(match["status"] == "waiting" for match in matches)


def test_ema_cloud_bounce_requires_close_above_entire_cloud():
    matches = ema_cloud_bounce_matches(
        [{"low": 99, "close": 105}],
        {"34": 100, "50": 110},
        {"34": 111, "50": 112},
        {"20": 113, "21": 114, "50": 115, "55": 116},
    )

    assert matches == []
