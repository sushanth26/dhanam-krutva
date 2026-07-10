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
    nine_ema_touch_matches,
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


def test_nine_ema_touch_matches_buys_bullish_stock_at_9ema_with_34_50_cloud_stop():
    matches = nine_ema_touch_matches(
        [{"low": 108.5, "high": 110.5, "close": 110, "time": "2026-07-02T09:50:00"}],
        {"5": 112, "9": 109.5, "12": 111, "34": 100, "50": 105},
        risk_amount=100,
    )

    assert [match["label"] for match in matches] == ["10m 9 EMA touch"]
    assert matches[0]["entry_price"] == 109.5
    assert matches[0]["trade_action"] == "Long"
    assert matches[0]["type"] == "10m_9ema_touch"
    assert matches[0]["risk_plan"]["entry"] == 109.5
    assert matches[0]["risk_plan"]["stop"] == 99
    assert matches[0]["risk_plan"]["stop_buffer"] == 1
    assert matches[0]["risk_plan"]["stop_mode"] == "10m-34-50-cloud"
    assert matches[0]["risk_plan"]["risk_per_share"] == 10.5
    assert matches[0]["risk_plan"]["shares"] == 9
    assert matches[0]["stop_cloud_low"] == 100
    assert matches[0]["stop_cloud_high"] == 105


def test_nine_ema_touch_matches_ignores_non_bullish_or_not_touching():
    bearish = nine_ema_touch_matches(
        [{"low": 108.5, "high": 110.5, "close": 110}],
        {"5": 102, "9": 109.5, "12": 103, "34": 105, "50": 106},
    )
    above_ema = nine_ema_touch_matches(
        [{"low": 110, "high": 112, "close": 111}],
        {"5": 112, "9": 109.5, "12": 111, "34": 100, "50": 105},
    )

    assert bearish == []
    assert above_ema == []


def test_nine_ema_touch_matches_only_during_first_regular_market_hour():
    ema_set = {"5": 112, "9": 109.5, "12": 111, "34": 100, "50": 105}

    premarket = nine_ema_touch_matches(
        [{"low": 108.5, "high": 110.5, "close": 110, "time": "2026-07-02T09:20:00"}],
        ema_set,
    )
    market_open = nine_ema_touch_matches(
        [{"low": 108.5, "high": 110.5, "close": 110, "time": "2026-07-02T09:30:00"}],
        ema_set,
    )
    last_first_hour_candle = nine_ema_touch_matches(
        [{"low": 108.5, "high": 110.5, "close": 110, "time": "2026-07-02T10:20:00"}],
        ema_set,
    )
    after_first_hour = nine_ema_touch_matches(
        [{"low": 108.5, "high": 110.5, "close": 110, "time": "2026-07-02T10:30:00"}],
        ema_set,
    )

    assert premarket == []
    assert [match["label"] for match in market_open] == ["10m 9 EMA touch"]
    assert [match["label"] for match in last_first_hour_candle] == ["10m 9 EMA touch"]
    assert after_first_hour == []


def test_nine_ema_touch_matches_all_day_after_prior_34_50_cloud_touch():
    matches = nine_ema_touch_matches(
        [
            {"low": 100, "high": 107, "close": 106, "time": "2026-07-02T13:10:00"},
            {"low": 108.5, "high": 110.5, "close": 110, "time": "2026-07-02T13:20:00"},
        ],
        {"5": 112, "9": 109.5, "12": 111, "34": 100, "50": 105},
    )

    assert [match["label"] for match in matches] == ["10m 9 EMA touch"]
    assert matches[0]["entry_price"] == 109.5


def test_nine_ema_touch_matches_after_first_hour_requires_recent_34_50_cloud_touch():
    candles = [
        {"low": 100, "high": 107, "close": 106, "time": "2026-07-02T12:30:00"},
        {"low": 112, "high": 114, "close": 113, "time": "2026-07-02T12:40:00"},
        {"low": 112, "high": 114, "close": 113, "time": "2026-07-02T12:50:00"},
        {"low": 112, "high": 114, "close": 113, "time": "2026-07-02T13:00:00"},
        {"low": 112, "high": 114, "close": 113, "time": "2026-07-02T13:10:00"},
        {"low": 108.5, "high": 110.5, "close": 110, "time": "2026-07-02T13:20:00"},
    ]

    matches = nine_ema_touch_matches(
        candles,
        {"5": 112, "9": 109.5, "12": 111, "34": 100, "50": 105},
    )

    assert matches == []


def test_nine_ema_touch_matches_after_first_hour_requires_prior_34_50_cloud_touch():
    matches = nine_ema_touch_matches(
        [
            {"low": 106, "high": 108, "close": 107, "time": "2026-07-02T13:10:00"},
            {"low": 108.5, "high": 110.5, "close": 110, "time": "2026-07-02T13:20:00"},
        ],
        {"5": 112, "9": 109.5, "12": 111, "34": 100, "50": 105},
    )

    assert matches == []


def test_mtf_matches_waits_when_active_candle_tests_cloud_ranges():
    matches = mtf_matches(
        105,
        "Bullish",
        {"34": 96, "50": 101},
        {"34": 100, "50": 110},
        {"20": 100, "21": 103, "50": 104, "55": 106},
        previous_price=95,
        current_low=99,
        current_high=106,
        candle_complete=False,
    )

    assert [match["label"] for match in matches] == ["Hourly 34/50", "Daily 20/21", "Daily 50/55"]
    assert [match["status"] for match in matches] == ["confirmed", "confirmed", "confirmed"]
    assert [match["direction"] for match in matches] == ["inside", "touch", "inside"]


def test_mtf_matches_alerts_when_price_is_inside_hourly_and_daily_clouds():
    matches = mtf_matches(
        105,
        "Bullish",
        {"34": 96, "50": 101},
        {"34": 100, "50": 110},
        {"20": 90, "21": 93, "50": 104, "55": 106},
        previous_price=95,
        current_low=104,
        current_high=106,
        candle_complete=True,
    )

    assert [match["label"] for match in matches] == ["Hourly 34/50", "Daily 50/55"]
    assert all(match["status"] == "confirmed" for match in matches)
    assert all(match["direction"] == "inside" for match in matches)
    assert all(match["type"] == "mtf_cloud_inside" for match in matches)
    assert all("trade_action" not in match for match in matches)


def test_mtf_signal_matches_alerts_when_stock_touched_hourly_cloud_earlier_in_day():
    matches = mtf_signal_matches(
        120,
        "Bullish",
        [
            {"low": 105, "high": 113, "close": 112, "source_count": 2, "session_date": "2026-07-02", "time": "2026-07-02T09:30:00"},
            {"low": 118, "high": 122, "close": 120, "source_count": 2, "session_date": "2026-07-02", "time": "2026-07-02T09:40:00"},
        ],
        {"5": 122, "12": 121, "34": 100, "50": 110},
        {"34": 100, "50": 110},
        {"20": 80, "21": 90, "50": 130, "55": 135},
    )

    assert [match["label"] for match in matches] == ["Hourly 34/50"]
    assert matches[0]["status"] == "confirmed"
    assert matches[0]["direction"] == "touch"
    assert matches[0]["type"] == "mtf_cloud_touch"
    assert "trade_action" not in matches[0]


def test_mtf_matches_alerts_bullish_only_after_price_closes_above_cloud():
    matches = mtf_matches(
        113,
        "Bullish",
        {"34": 100, "50": 110},
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
    assert [match["risk_plan"]["stop"] for match in matches] == [97, 105, 101]
    assert all(match["risk_plan"]["stop_buffer"] == 3 for match in matches)
    assert all(match["risk_plan"]["stop_mode"] == "mtf-cloud-3-dollar" for match in matches)


def test_mtf_matches_alerts_bearish_only_after_price_closes_below_cloud():
    matches = mtf_matches(
        99,
        "Bearish",
        {"34": 100, "50": 110},
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
    assert [match["risk_plan"]["stop"] for match in matches] == [113, 109]
    assert all(match["risk_plan"]["stop_buffer"] == 3 for match in matches)
    assert all(match["risk_plan"]["stop_mode"] == "mtf-cloud-3-dollar" for match in matches)


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


def test_mtf_signal_matches_prefers_confirmed_bounce_over_matching_breakout_name():
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

    assert [match["label"] for match in matches][:3] == [
        "10m bounce Hourly 34/50",
        "10m bounce Daily 20/21",
        "10m bounce Daily 50/55",
    ]
    assert "Hourly 34/50" not in [match["label"] for match in matches]
    assert "Daily 20/21" not in [match["label"] for match in matches]
    assert "Daily 50/55" not in [match["label"] for match in matches]
    assert matches[0]["status"] == "confirmed"
    assert matches[0]["candle_time"] == "2026-07-02T09:40:00"
    assert matches[2]["candle_time"] == "2026-07-02T09:40:00"


def test_mtf_signal_matches_dedupes_bearish_rejection_and_matching_breakout_name():
    matches = mtf_signal_matches(
        97,
        "Bearish",
        [
            {"low": 113, "high": 121, "close": 118, "time": "2026-07-02T09:30:00"},
            {"open": 102, "high": 111, "low": 98, "close": 97, "time": "2026-07-02T09:40:00"},
        ],
        {"5": 94, "12": 95, "34": 100, "50": 110},
        {"34": 104, "50": 108},
        {"20": 105, "21": 107, "50": 106, "55": 109},
    )

    labels = [match["label"] for match in matches]
    assert labels == [
        "10m bounce Hourly 34/50",
        "10m bounce Daily 20/21",
        "10m bounce Daily 50/55",
        "10m bounce 34/50",
    ]
    assert "Hourly 34/50" not in labels
    assert "Daily 20/21" not in labels
    assert "Daily 50/55" not in labels
    assert all(match["display_label"].replace("10m rejection", "10m bounce") == match["label"] for match in matches)
    assert all(match["trade_action"] == "Short" for match in matches)


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
    assert [match["status"] for match in matches[:2]] == ["confirmed", "confirmed"]
    assert [match["direction"] for match in matches[:2]] == ["inside", "inside"]
    assert all(match["label"] != "10m bounce 34/50" for match in matches)
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
    assert statuses["Hourly 34/50"] == "confirmed"
    assert {match["label"]: match["direction"] for match in matches}["Hourly 34/50"] == "touch"
    assert "10m bounce 34/50" not in statuses
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


def test_mtf_signal_matches_waits_for_a_plus_plus_bullish_breakout_before_candle_close():
    matches = mtf_signal_matches(
        113,
        "Bullish",
        [{"open": 111, "low": 99, "high": 113, "close": 113, "source_count": 1, "time": "2026-07-02T09:50:00"}],
        {"5": 116, "12": 114, "34": 100, "50": 110},
        {"34": 120, "50": 121},
        {"20": 122, "21": 123, "50": 124, "55": 125},
    )

    assert all(match["label"] != "10m bounce 34/50" for match in matches)


def test_mtf_signal_matches_confirms_a_plus_plus_bounce_after_candle_close():
    matches = mtf_signal_matches(
        113,
        "Bullish",
        [{"open": 111, "low": 99, "close": 113, "source_count": 2, "time": "2026-07-02T09:50:00"}],
        {"5": 116, "12": 114, "34": 100, "50": 110},
        {"34": 120, "50": 121},
        {"20": 122, "21": 123, "50": 124, "55": 125},
    )

    assert [match["label"] for match in matches] == ["10m bounce 34/50"]
    assert all(match["status"] == "confirmed" for match in matches)


def test_ema_cloud_bounce_ignores_10m_bullish_price_below_cloud():
    matches = ema_cloud_bounce_matches(
        [{"low": 99, "high": 106, "close": 105}],
        {"5": 116, "12": 114, "34": 100, "50": 110},
        {"34": 111, "50": 112},
        {"20": 113, "21": 114, "50": 115, "55": 116},
    )

    assert matches == []


def test_ema_cloud_bounce_ignores_10m_bullish_breakout_without_cloud_touch():
    matches = ema_cloud_bounce_matches(
        [{"low": 111, "high": 113, "close": 112, "source_count": 1}],
        {"5": 116, "12": 114, "34": 100, "50": 110},
        {"34": 111, "50": 112},
        {"20": 113, "21": 114, "50": 115, "55": 116},
    )

    assert matches == []


def test_ema_cloud_bounce_sizes_a_plus_plus_bullish_after_touch_and_move_above_cloud():
    matches = ema_cloud_bounce_matches(
        [{"low": 99, "high": 112, "close": 112, "source_count": 2}],
        {"5": 116, "12": 114, "34": 100, "50": 110},
        {"34": 111, "50": 112},
        {"20": 113, "21": 114, "50": 115, "55": 116},
    )

    assert [match["label"] for match in matches] == ["10m bounce 34/50"]
    assert matches[0]["trend"] == "Bullish"
    assert matches[0]["risk_plan"]["entry"] == 112
    assert matches[0]["risk_plan"]["stop"] == 99
    assert matches[0]["risk_plan"]["stop_buffer"] == 1
    assert matches[0]["risk_plan"]["stop_mode"] == "10m-34-50-cloud"
    assert matches[0]["risk_plan"]["risk_per_share"] == 13
    assert matches[0]["risk_plan"]["shares"] == 7
    assert matches[0]["stop_cloud_low"] == 100
    assert matches[0]["stop_cloud_high"] == 110


def test_ema_cloud_bounce_sizes_a_plus_plus_bearish_stop_above_cloud():
    matches = ema_cloud_bounce_matches(
        [{"low": 97, "high": 106, "close": 97}],
        {"5": 90, "12": 95, "34": 100, "50": 110},
        {"34": 111, "50": 112},
        {"20": 113, "21": 114, "50": 115, "55": 116},
    )

    assert [match["label"] for match in matches] == ["10m bounce 34/50"]
    assert matches[0]["trend"] == "Bearish"
    assert matches[0]["display_label"] == "10m rejection 34/50"
    assert matches[0]["entry_price"] == 97
    assert matches[0]["risk_plan"]["entry"] == 97
    assert matches[0]["risk_plan"]["stop"] == 111
    assert matches[0]["risk_plan"]["stop_buffer"] == 1
    assert matches[0]["risk_plan"]["risk_per_share"] == 14
    assert matches[0]["risk_plan"]["shares"] == 7


def test_ema_cloud_bounce_auto_sizes_from_last_three_daily_ranges():
    daily_candles = [
        {"high": 120, "low": 100, "close": 110},
        {"high": 125, "low": 103, "close": 118},
        {"high": 123, "low": 102, "close": 119},
    ]

    matches = ema_cloud_bounce_matches(
        [{"low": 99, "high": 112, "close": 112}],
        {"5": 116, "12": 114, "34": 100, "50": 110},
        {"34": 111, "50": 112},
        {"20": 113, "21": 114, "50": 115, "55": 116},
        daily_candles=daily_candles,
        risk_amount=200,
        stop_mode="auto",
    )

    risk_plan = matches[0]["risk_plan"]
    assert risk_plan["stop_mode"] == "10m-34-50-cloud"
    assert risk_plan["stop_buffer"] == 1
    assert risk_plan["stop"] == 99
    assert risk_plan["risk_per_share"] == 13
    assert risk_plan["max_risk"] == 200
    assert risk_plan["shares"] == 15
    assert risk_plan["volatility"]["grade"] == "fixed"
    assert risk_plan["volatility"]["average_range"] is None


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
