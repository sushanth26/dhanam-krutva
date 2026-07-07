from datetime import datetime, timedelta

from app.market_data import (
    LIVE_WATCHLIST,
    aggregate_by_minutes,
    batch_history_bars_chunked,
    daily_volatility,
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


def test_mtf_matches_waits_when_active_candle_tests_cloud_ranges():
    matches = mtf_matches(
        105,
        "Bullish",
        {"34": 100, "50": 110},
        {"20": 100, "21": 103, "50": 104, "55": 106},
        previous_price=95,
        current_low=99,
        current_high=106,
        candle_complete=False,
    )

    assert [match["label"] for match in matches] == ["Hourly 34/50", "Daily 20/21", "Daily 50/55"]
    assert [match["status"] for match in matches] == ["waiting", "waiting", "waiting"]


def test_mtf_matches_alerts_bullish_only_after_price_closes_above_cloud():
    matches = mtf_matches(
        113,
        "Bullish",
        {"34": 100, "50": 110},
        {"20": 108, "21": 112, "50": 104, "55": 106},
        previous_price=105,
        current_low=104,
        current_high=112,
        candle_complete=True,
    )

    assert [match["label"] for match in matches] == ["Hourly 34/50", "Daily 20/21", "Daily 50/55"]
    assert all(match["status"] == "confirmed" and match["direction"] == "above" for match in matches)
    assert all(match["trade_action"] == "Long" for match in matches)


def test_mtf_matches_alerts_bearish_only_after_price_closes_below_cloud():
    matches = mtf_matches(
        99,
        "Bearish",
        {"34": 100, "50": 110},
        {"20": 80, "21": 90, "50": 104, "55": 106},
        previous_price=105,
        current_low=98,
        current_high=106,
        candle_complete=True,
    )

    assert [match["label"] for match in matches] == ["Hourly 34/50", "Daily 50/55"]
    assert all(match["status"] == "confirmed" and match["direction"] == "below" for match in matches)
    assert all(match["trade_action"] == "Short" for match in matches)


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


def test_mtf_signal_matches_keeps_confirmed_bullish_breakout():
    matches = mtf_signal_matches(
        113,
        "Bullish",
        [
            {"low": 99, "high": 106, "close": 105, "time": "2026-07-02T09:30:00"},
            {"low": 104, "high": 114, "close": 113, "time": "2026-07-02T09:40:00"},
        ],
        {"5": 116, "12": 114, "34": 100, "50": 110},
        {"34": 100, "50": 110},
        {"20": 108, "21": 112, "50": 104, "55": 106},
    )

    assert [match["label"] for match in matches][:3] == ["Hourly 34/50", "Daily 20/21", "Daily 50/55"]
    assert matches[0]["status"] == "confirmed"
    assert matches[0]["candle_time"] == "2026-07-02T09:40:00"
    assert matches[2]["candle_time"] == "2026-07-02T09:40:00"


def test_mtf_signal_matches_marks_incomplete_10m_candle_as_waiting():
    matches = mtf_signal_matches(
        105,
        "Bullish",
        [
            {"low": 94, "high": 98, "close": 95, "source_count": 2, "time": "2026-07-02T09:30:00"},
            {"low": 99, "high": 106, "close": 105, "source_count": 1, "time": "2026-07-02T09:40:00"},
        ],
        {"5": 116, "12": 114, "34": 100, "50": 110},
        {"34": 100, "50": 110},
        {"20": 80, "21": 90, "50": 104, "55": 106},
    )

    assert [match["label"] for match in matches][:2] == ["Hourly 34/50", "Daily 50/55"]
    assert [match["status"] for match in matches[:2]] == ["waiting", "waiting"]
    assert any(match["label"] == "10m bounce 34/50" and match["status"] == "confirmed" for match in matches)
    assert matches[0]["candle_time"] == "2026-07-02T09:40:00"


def test_mtf_signal_matches_waits_for_incomplete_breakouts_until_candle_close():
    matches = mtf_signal_matches(
        113,
        "Bullish",
        [
            {"low": 94, "high": 98, "close": 95, "source_count": 2, "time": "2026-07-02T09:30:00"},
            {"low": 109, "high": 114, "close": 113, "source_count": 1, "time": "2026-07-02T09:40:00"},
        ],
        {"5": 116, "12": 114, "34": 100, "50": 110},
        {"34": 100, "50": 110},
        {"20": 80, "21": 90, "50": 104, "55": 106},
    )

    statuses = {match["label"]: match["status"] for match in matches}
    assert statuses["Hourly 34/50"] == "waiting"
    assert statuses["10m bounce 34/50"] == "confirmed"
    assert "Daily 20/21" not in statuses
    assert "Daily 50/55" not in statuses


def test_mtf_signal_matches_does_not_alert_when_price_was_already_above_clouds():
    matches = mtf_signal_matches(
        113,
        "Bullish",
        [
            {"low": 110, "high": 115, "close": 112, "source_count": 2, "time": "2026-07-02T09:30:00"},
            {"low": 111, "high": 116, "close": 113, "source_count": 2, "time": "2026-07-02T09:40:00"},
        ],
        {"5": 116, "12": 114, "34": 100, "50": 110},
        {"34": 100, "50": 110},
        {"20": 80, "21": 90, "50": 104, "55": 106},
    )

    assert matches == []


def test_mtf_signal_matches_does_not_wait_when_incomplete_candle_is_far_from_cloud():
    matches = mtf_signal_matches(
        130,
        "Bullish",
        [
            {"low": 120, "high": 125, "close": 124, "source_count": 2, "time": "2026-07-02T09:30:00"},
            {"low": 128, "high": 132, "close": 130, "source_count": 1, "time": "2026-07-02T09:40:00"},
        ],
        {"5": 116, "12": 114, "34": 100, "50": 110},
        {"34": 100, "50": 110},
        {"20": 80, "21": 90, "50": 104, "55": 106},
    )

    assert matches == []


def test_ema_cloud_bounce_matches_alerts_when_10m_candle_closes_back_above_clouds():
    candles = [
        {"low": 93, "close": 97},
        {"open": 111, "low": 99, "close": 112},
    ]

    matches = ema_cloud_bounce_matches(
        candles,
        {"5": 113, "12": 112, "34": 100, "50": 110},
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
    assert matches[0]["trend"] == "Bullish"
    assert all(match["trade_action"] == "Long" for match in matches)
    assert matches[0]["candle_time"] is None


def test_ema_cloud_bounce_matches_alerts_when_bearish_10m_candle_closes_below_clouds():
    candles = [
        {"low": 113, "high": 121, "close": 118},
        {"open": 102, "high": 111, "low": 98, "close": 97},
    ]

    matches = ema_cloud_bounce_matches(
        candles,
        {"5": 94, "12": 95, "34": 100, "50": 110},
        {"34": 104, "50": 108},
        {"20": 105, "21": 107, "50": 106, "55": 109},
    )

    assert [match["label"] for match in matches] == [
        "10m bounce 34/50",
        "10m bounce Hourly 34/50",
        "10m bounce Daily 20/21",
        "10m bounce Daily 50/55",
    ]
    assert all(match["trend"] == "Bearish" for match in matches)
    assert all(match["trade_action"] == "Short" for match in matches)


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
    assert matches[0]["trade_action"] == "Long"


def test_ema_cloud_bounce_alerts_10m_34_50_when_trend_is_bearish():
    matches = ema_cloud_bounce_matches(
        [{"low": 99, "high": 108, "close": 96}],
        {"5": 90, "12": 95, "34": 100, "50": 110},
        {"34": 120, "50": 121},
        {"20": 122, "21": 123, "50": 124, "55": 125},
    )

    assert matches[0]["label"] == "10m bounce 34/50"
    assert matches[0]["trend"] == "Bearish"
    assert matches[0]["trade_action"] == "Short"


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


def test_mtf_signal_matches_confirms_a_plus_plus_bounce_immediately():
    matches = mtf_signal_matches(
        113,
        "Bullish",
        [{"open": 111, "low": 99, "close": 113, "source_count": 1, "time": "2026-07-02T09:50:00"}],
        {"5": 116, "12": 114, "34": 100, "50": 110},
        {"34": 120, "50": 121},
        {"20": 122, "21": 123, "50": 124, "55": 125},
    )

    assert [match["label"] for match in matches] == ["10m bounce 34/50"]
    assert all(match["status"] == "confirmed" for match in matches)


def test_ema_cloud_bounce_alerts_10m_touch_without_waiting_for_close_above():
    matches = ema_cloud_bounce_matches(
        [{"low": 99, "high": 106, "close": 105}],
        {"5": 116, "12": 114, "34": 100, "50": 110},
        {"34": 111, "50": 112},
        {"20": 113, "21": 114, "50": 115, "55": 116},
    )

    assert [match["label"] for match in matches] == ["10m bounce 34/50"]
    assert matches[0]["trend"] == "Bullish"
    assert matches[0]["risk_plan"]["entry"] == 105
    assert matches[0]["risk_plan"]["stop"] == 99
    assert matches[0]["risk_plan"]["stop_buffer"] == 1
    assert matches[0]["risk_plan"]["risk_per_share"] == 6
    assert matches[0]["risk_plan"]["shares"] == 16


def test_ema_cloud_bounce_sizes_a_plus_plus_bearish_stop_above_cloud():
    matches = ema_cloud_bounce_matches(
        [{"low": 99, "high": 106, "close": 104}],
        {"5": 90, "12": 95, "34": 100, "50": 110},
        {"34": 111, "50": 112},
        {"20": 113, "21": 114, "50": 115, "55": 116},
    )

    assert [match["label"] for match in matches] == ["10m bounce 34/50"]
    assert matches[0]["trend"] == "Bearish"
    assert matches[0]["risk_plan"]["entry"] == 104
    assert matches[0]["risk_plan"]["stop"] == 111
    assert matches[0]["risk_plan"]["stop_buffer"] == 1
    assert matches[0]["risk_plan"]["risk_per_share"] == 7
    assert matches[0]["risk_plan"]["shares"] == 14


def test_ema_cloud_bounce_auto_sizes_from_last_three_daily_ranges():
    daily_candles = [
        {"high": 120, "low": 100, "close": 110},
        {"high": 125, "low": 103, "close": 118},
        {"high": 123, "low": 102, "close": 119},
    ]

    matches = ema_cloud_bounce_matches(
        [{"low": 99, "high": 106, "close": 105}],
        {"5": 116, "12": 114, "34": 100, "50": 110},
        {"34": 111, "50": 112},
        {"20": 113, "21": 114, "50": 115, "55": 116},
        daily_candles=daily_candles,
        risk_amount=200,
        stop_mode="auto",
    )

    risk_plan = matches[0]["risk_plan"]
    assert risk_plan["stop_mode"] == "auto"
    assert risk_plan["stop_buffer"] == 2.52
    assert risk_plan["stop"] == 97.48
    assert risk_plan["risk_per_share"] == 7.52
    assert risk_plan["max_risk"] == 200
    assert risk_plan["shares"] == 26
    assert risk_plan["volatility"]["grade"] == "fast"
    assert risk_plan["volatility"]["average_range"] == 21


def test_daily_volatility_grades_slow_names_from_last_three_days():
    volatility = daily_volatility(
        [
            {"high": 101, "low": 100},
            {"high": 102, "low": 101},
            {"high": 103, "low": 102},
            {"high": 104, "low": 103},
        ],
        100,
    )

    assert volatility == {
        "grade": "slow",
        "average_range": 1,
        "average_range_pct": 1,
        "sample_size": 3,
    }
