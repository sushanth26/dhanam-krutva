from datetime import datetime, timedelta

from app.market_data import (
    LIVE_WATCHLIST,
    aggregate_by_minutes,
    batch_history_bars_chunked,
    daily_volatility,
    ema_touch_matches,
    ema_cloud_bounce_matches,
    ema_values,
    mtf_cloud_touch_matches,
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
    assert [match["status"] for match in matches] == ["waiting", "confirmed", "waiting"]
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
    assert all(match["status"] == "waiting" for match in matches)
    assert all(match["direction"] == "inside" for match in matches)
    assert all(match["type"] == "mtf_cloud_inside" for match in matches)
    assert all("trade_action" not in match for match in matches)


def test_mtf_matches_alerts_when_current_intraday_candle_touches_hourly_cloud():
    matches = mtf_matches(
        120,
        "Bullish",
        {"5": 122, "12": 121, "34": 100, "50": 110},
        {"34": 100, "50": 110},
        {"20": 80, "21": 90, "50": 130, "55": 135},
        previous_price=116,
        current_low=105,
        current_high=121,
        candle_complete=True,
    )

    assert [match["label"] for match in matches] == ["Hourly 34/50"]
    assert matches[0]["status"] == "confirmed"
    assert matches[0]["direction"] == "touch"
    assert matches[0]["type"] == "mtf_cloud_touch"
    assert "trade_action" not in matches[0]


def test_ema_touch_matches_alerts_single_hourly_and_daily_emas_immediately():
    matches = ema_touch_matches(
        112,
        109.5,
        112.5,
        {"20": 108, "21": 110, "34": 111, "50": 115, "55": 116},
        {"20": 95, "21": 96, "50": 112, "55": 120},
        candle_time="2026-07-02T09:40:00",
        ten_minute_trend="Chop",
    )

    assert [match["label"] for match in matches] == [
        "Hourly 34 EMA touch",
        "Daily 50 EMA touch",
    ]
    assert all(match["status"] == "confirmed" for match in matches)
    assert all(match["type"] == "ema_touch" for match in matches)
    assert all("trade_action" not in match for match in matches)
    assert matches[0]["entry_price"] == 111
    assert matches[0]["candle_time"] == "2026-07-02T09:40:00"


def test_mtf_signal_matches_skips_chop_trend():
    matches = mtf_signal_matches(
        112,
        "Chop",
        [
            {"low": 100, "high": 106, "close": 105, "source_count": 2, "session_date": "2026-07-02", "time": "2026-07-02T09:30:00"},
            {"low": 109.5, "high": 112.5, "close": 112, "source_count": 1, "session_date": "2026-07-02", "time": "2026-07-02T09:40:00"},
        ],
        {"5": 106, "9": 108, "12": 109, "34": 107, "50": 110},
        {"20": 108, "21": 110, "34": 111, "50": 115, "55": 116},
        {"20": 95, "21": 96, "50": 112, "55": 120},
    )

    assert matches == []


def test_mtf_cloud_touch_matches_alerts_when_latest_candle_touches_and_moves_up():
    matches = mtf_cloud_touch_matches(
        116,
        {"34": 111, "50": 115},
        {"20": 108, "21": 114, "50": 130, "55": 140},
        latest_candle={"low": 112, "high": 116, "close": 116, "source_count": 2},
        candle_time="2026-07-02T09:40:00",
    )

    assert [match["label"] for match in matches] == ["Hourly 34/50", "Daily 20/21"]
    assert all(match["status"] == "confirmed" for match in matches)
    assert all(match["direction"] == "bounce_up" for match in matches)
    assert all(match["type"] == "mtf_cloud_price_touch" for match in matches)
    assert all(match["trade_action"] == "Long" for match in matches)
    assert all(match["candle_time"] == "2026-07-02T09:40:00" for match in matches)
    assert matches[0]["entry_price"] == 116
    assert matches[0]["cloud_low"] == 111
    assert matches[0]["cloud_high"] == 115


def test_mtf_cloud_touch_matches_alerts_when_latest_candle_touches_and_moves_down():
    matches = mtf_cloud_touch_matches(
        107,
        {"34": 111, "50": 115},
        {"20": 108, "21": 110, "50": 130, "55": 140},
        latest_candle={"low": 107, "high": 112, "close": 107, "source_count": 2},
        candle_time="2026-07-02T09:40:00",
    )

    assert [match["label"] for match in matches] == ["Hourly 34/50", "Daily 20/21"]
    assert all(match["direction"] == "reject_down" for match in matches)
    assert all(match["trade_action"] == "Short" for match in matches)


def test_mtf_cloud_touch_matches_ignores_price_still_inside_cloud():
    matches = mtf_cloud_touch_matches(
        112,
        {"34": 111, "50": 115},
        {"20": 108, "21": 114, "50": 130, "55": 140},
        latest_candle={"low": 112, "high": 116, "close": 112, "source_count": 2},
    )

    assert matches == []


def test_mtf_cloud_touch_matches_ignores_incomplete_10m_candle():
    matches = mtf_cloud_touch_matches(
        116,
        {"34": 111, "50": 115},
        {"20": 108, "21": 110, "50": 130, "55": 140},
        latest_candle={"low": 111, "high": 116, "close": 116, "source_count": 1},
    )

    assert matches == []


def test_mtf_signal_matches_adds_cloud_touch_when_live_price_given():
    matches = mtf_signal_matches(
        116,
        "Chop",
        [
            {"low": 100, "high": 106, "close": 105, "source_count": 2, "session_date": "2026-07-02", "time": "2026-07-02T09:30:00"},
            {"low": 109.5, "high": 116.5, "close": 116, "source_count": 2, "session_date": "2026-07-02", "time": "2026-07-02T09:40:00"},
        ],
        {"5": 106, "9": 108, "12": 109, "34": 107, "50": 110},
        {"20": 108, "21": 110, "34": 111, "50": 115, "55": 116},
        {"20": 95, "21": 96, "50": 118, "55": 120},
        live_price=116,
    )

    assert [match["label"] for match in matches] == ["Hourly 34/50"]
    assert matches[0]["type"] == "mtf_cloud_price_touch"
    assert matches[0]["direction"] == "bounce_up"
    assert matches[0]["candle_time"] == "2026-07-02T09:40:00"


def test_mtf_signal_matches_waits_for_confirmed_mtf_touch_candle_close():
    matches = mtf_signal_matches(
        116,
        "Chop",
        [
            {"low": 100, "high": 106, "close": 105, "source_count": 2, "session_date": "2026-07-02", "time": "2026-07-02T09:30:00"},
            {"low": 109.5, "high": 116.5, "close": 116, "source_count": 1, "session_date": "2026-07-02", "time": "2026-07-02T09:40:00"},
        ],
        {"5": 106, "9": 108, "12": 109, "34": 107, "50": 110},
        {"20": 108, "21": 110, "34": 111, "50": 115, "55": 116},
        {"20": 95, "21": 96, "50": 118, "55": 120},
        live_price=116,
    )

    assert [match for match in matches if match["type"] == "mtf_cloud_price_touch"] == []


def seeded_pullback_candles(
    touch_candle: dict,
    trigger_candle: dict,
    touch_offset_minutes: int = 120,
    trigger_offset_minutes: int = 130,
) -> list[dict]:
    start_time = datetime.fromisoformat("2026-07-02T09:00:00")

    def candle_time(offset_minutes: int) -> str:
        return (start_time + timedelta(minutes=offset_minutes)).isoformat()

    candles = []
    for index in range(12):
        candles.append(
            {
                "low": 119,
                "high": 121,
                "close": 120,
                "source_count": 2,
                "session_date": "2026-07-02",
                "time": candle_time(index * 10),
            }
        )
    return [
        *candles,
        {
            "source_count": 2,
            "session_date": "2026-07-02",
            "time": candle_time(touch_offset_minutes),
            **touch_candle,
        },
        {
            "source_count": 1,
            "session_date": "2026-07-02",
            "time": candle_time(trigger_offset_minutes),
            **trigger_candle,
        },
    ]


def test_mtf_signal_matches_alerts_long_after_same_day_mtf_touch_and_10m_5_12_touch():
    matches = mtf_signal_matches(
        120,
        "Bullish",
        seeded_pullback_candles(
            {"low": 105, "high": 110, "close": 105},
            {"low": 118, "high": 123, "close": 123},
        ),
        {"5": 122, "12": 121, "34": 100, "50": 110},
        {"34": 100, "50": 110},
        {"20": 80, "21": 90, "50": 130, "55": 135},
    )

    assert len(matches) == 1
    assert matches[0]["label"] == "Curl"
    assert matches[0]["display_label"] == "Curl: Hourly 34/50 -> above 10m 5/12"
    assert matches[0]["trade_action"] == "Long"
    assert matches[0]["trend"] == "Bullish"
    assert matches[0]["type"] == "long_mtf_5_12_touch"
    assert matches[0]["mtf_label"] == "Hourly 34/50"
    assert matches[0]["mtf_touch_time"] == "2026-07-02T11:00:00"
    assert matches[0]["candle_time"] == "2026-07-02T11:10:00"
    assert matches[0]["entry_price"] == 122
    assert matches[0]["risk_plan"]["stop"] == 99
    assert matches[0]["risk_plan"]["shares"] == 4


def test_mtf_signal_matches_ignores_curl_when_mtf_touch_is_older_than_one_hour():
    matches = mtf_signal_matches(
        120,
        "Bullish",
        seeded_pullback_candles(
            {"low": 105, "high": 110, "close": 105},
            {"low": 118, "high": 123, "close": 123},
            touch_offset_minutes=60,
            trigger_offset_minutes=130,
        ),
        {"5": 122, "12": 121, "34": 100, "50": 110},
        {"34": 100, "50": 110},
        {"20": 80, "21": 90, "50": 130, "55": 135},
    )

    assert [match for match in matches if match["type"] == "long_mtf_5_12_touch"] == []


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


def test_mtf_signal_matches_returns_all_matching_mtf_sources_for_long_alert():
    matches = mtf_signal_matches(
        113,
        "Bullish",
        seeded_pullback_candles(
            {"low": 99, "high": 106, "close": 105},
            {"low": 104, "high": 117, "close": 117},
        ),
        {"5": 116, "12": 114, "34": 100, "50": 110},
        {"34": 100, "50": 110},
        {"20": 108, "21": 112, "50": 104, "55": 106},
    )

    assert len(matches) == 1
    assert matches[0]["mtf_labels"] == [
        "Hourly 34/50",
        "Daily 50/55",
    ]
    assert matches[0]["mtf_label"] == "Hourly 34/50 + Daily 50/55"
    assert matches[0]["display_label"] == "Curl: Hourly 34/50 + Daily 50/55 -> above 10m 5/12"
    assert matches[0]["trade_action"] == "Long"
    assert matches[0]["status"] == "confirmed"
    assert matches[0]["candle_time"] == "2026-07-02T11:10:00"


def test_mtf_signal_matches_allows_bearish_trend_but_still_long_only():
    matches = mtf_signal_matches(
        101,
        "Bearish",
        seeded_pullback_candles(
            {"low": 94, "high": 99, "close": 93},
            {"open": 96, "high": 103, "low": 95, "close": 103},
        ),
        {"5": 100, "12": 102, "34": 110, "50": 112},
        {"34": 94, "50": 98},
        {"20": 95, "21": 97, "50": 96, "55": 99},
    )

    assert len(matches) == 1
    assert matches[0]["mtf_labels"] == [
        "Hourly 34/50",
        "Daily 20/21",
        "Daily 50/55",
    ]
    assert matches[0]["mtf_label"] == "Hourly 34/50 + Daily 20/21 + Daily 50/55"
    assert matches[0]["trade_action"] == "Long"
    assert matches[0]["trend"] == "Bearish"


def test_mtf_signal_matches_requires_curl_mtf_cloud_below_10m_5_12_cloud():
    matches = mtf_signal_matches(
        123,
        "Bullish",
        seeded_pullback_candles(
            {"low": 121, "high": 123, "close": 121},
            {"low": 118, "high": 124, "close": 123},
        ),
        {"5": 122, "12": 121, "34": 100, "50": 110},
        {"34": 121, "50": 123},
        {"20": 80, "21": 90, "50": 130, "55": 135},
    )

    assert [match for match in matches if match["type"] == "long_mtf_5_12_touch"] == []


def test_mtf_signal_matches_alerts_immediately_on_incomplete_10m_touch():
    matches = mtf_signal_matches(
        105,
        "Bullish",
        seeded_pullback_candles(
            {"low": 104, "high": 106, "close": 105},
            {"low": 113, "high": 117, "close": 117},
        ),
        {"5": 116, "12": 114, "34": 100, "50": 110},
        {"34": 100, "50": 110},
        {"20": 80, "21": 90, "50": 104, "55": 106},
    )

    assert len(matches) == 1
    assert matches[0]["mtf_labels"] == ["Hourly 34/50", "Daily 50/55"]
    assert matches[0]["status"] == "confirmed"
    assert matches[0]["candle_time"] == "2026-07-02T11:10:00"


def test_mtf_signal_matches_requires_curl_close_above_10m_5_12_cloud():
    matches = mtf_signal_matches(
        120,
        "Bullish",
        seeded_pullback_candles(
            {"low": 105, "high": 110, "close": 105},
            {"low": 118, "high": 122, "close": 120},
        ),
        {"5": 122, "12": 121, "34": 100, "50": 110},
        {"34": 100, "50": 110},
        {"20": 80, "21": 90, "50": 130, "55": 135},
    )

    assert [match for match in matches if match["type"] == "long_mtf_5_12_touch"] == []


def test_mtf_signal_matches_ignores_mtf_touch_after_price_already_reclaimed_10m_5_12():
    matches = mtf_signal_matches(
        120,
        "Bullish",
        seeded_pullback_candles(
            {"low": 100, "high": 121, "close": 120},
            {"low": 118, "high": 122, "close": 120},
        ),
        {"5": 122, "12": 121, "34": 100, "50": 110},
        {"34": 100, "50": 110},
        {"20": 80, "21": 90, "50": 130, "55": 135},
    )

    assert matches == []


def test_mtf_signal_matches_includes_confirmed_10m_34_50_bounce_as_separate_setup():
    candles = [
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T09:30:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T09:40:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T09:50:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T10:00:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T10:10:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T10:20:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T10:30:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T10:40:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T10:50:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T11:00:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T11:10:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T11:20:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T11:30:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T11:40:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T11:50:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T12:00:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T12:10:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T12:20:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T12:30:00"},
        {"low": 100.1, "high": 106, "close": 105, "source_count": 2, "time": "2026-07-02T12:40:00"},
    ]

    matches = mtf_signal_matches(
        105,
        "Chop",
        candles,
        {"5": 105, "12": 104, "34": 101, "50": 100},
        {"34": 90, "50": 95},
        {"20": 80, "21": 90, "50": 70, "55": 75},
    )

    assert len(matches) == 1
    assert matches[0]["label"] == "10m 34/50 Bounce"
    assert matches[0]["display_label"] == "Good 34/50 Bounce"
    assert matches[0]["type"] == "10m_34_50_bounce"
    assert matches[0]["setup_quality"] == "good"
    assert matches[0]["setup_quality_note"] == "Clear room above 10m 34/50"
    assert matches[0]["overhead_clouds"] == []
    assert matches[0]["risk_plan"]["stop"] == 99.1961
    assert matches[0]["risk_plan"]["shares"] == 17
    assert matches[0]["trade_action"] == "Long"
    assert matches[0]["trend"] == "Bullish"
    assert matches[0]["entry_price"] == 105
    assert matches[0]["candle_time"] == "2026-07-02T12:40:00"


def test_mtf_signal_matches_marks_10m_34_50_bounce_bad_when_mtf_cloud_is_overhead():
    candles = [
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T09:30:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T09:40:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T09:50:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T10:00:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T10:10:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T10:20:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T10:30:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T10:40:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T10:50:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T11:00:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T11:10:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T11:20:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T11:30:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T11:40:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T11:50:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T12:00:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T12:10:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T12:20:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T12:30:00"},
        {"low": 100.1, "high": 106, "close": 105, "source_count": 2, "time": "2026-07-02T12:40:00"},
    ]

    matches = mtf_signal_matches(
        105,
        "Chop",
        candles,
        {"5": 105, "12": 104, "34": 101, "50": 100},
        {"34": 106, "50": 107},
        {"20": 80, "21": 90, "50": 70, "55": 75},
    )

    bounce_matches = [match for match in matches if match["type"] == "10m_34_50_bounce"]
    mtf_touch_matches = [match for match in matches if match["type"] == "mtf_cloud_price_touch"]

    assert len(bounce_matches) == 1
    assert bounce_matches[0]["display_label"] == "Bad 34/50 Bounce"
    assert bounce_matches[0]["setup_quality"] == "bad"
    assert bounce_matches[0]["setup_quality_note"] == "Overhead cloud nearby: Hourly 34/50"
    assert bounce_matches[0]["overhead_clouds"] == [
        {"label": "Hourly 34/50", "cloud_low": 106, "cloud_high": 107, "distance_pct": 0.95}
    ]
    assert [match["direction"] for match in mtf_touch_matches] == ["reject_down"]


def test_mtf_signal_matches_waits_for_confirmed_10m_34_50_bounce_close():
    candles = [
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T09:30:00"},
        {"low": 99, "high": 101, "close": 100, "source_count": 2, "time": "2026-07-02T09:40:00"},
        {"low": 100, "high": 106, "close": 105, "source_count": 1, "time": "2026-07-02T09:50:00"},
    ]

    matches = mtf_signal_matches(
        105,
        "Bullish",
        candles,
        {"5": 105, "12": 104, "34": 101, "50": 100},
        {"34": 90, "50": 95},
        {"20": 80, "21": 90, "50": 70, "55": 75},
    )

    assert [match for match in matches if match["type"] == "10m_34_50_bounce"] == []


def test_mtf_signal_matches_requires_move_up_into_10m_5_12():
    matches = mtf_signal_matches(
        105,
        "Bullish",
        [
            {"low": 94, "high": 98, "close": 106, "source_count": 2, "time": "2026-07-02T09:30:00"},
            {"low": 99, "high": 106, "close": 105, "source_count": 1, "time": "2026-07-02T09:40:00"},
        ],
        {"5": 104, "12": 106, "34": 90, "50": 95},
        {"34": 94, "50": 98},
        {"20": 80, "21": 90, "50": 94, "55": 98},
    )

    assert matches == []


def test_mtf_signal_matches_requires_mtf_touch_from_same_trading_day():
    matches = mtf_signal_matches(
        113,
        "Bullish",
        [
            {"low": 100, "high": 110, "close": 106, "source_count": 2, "session_date": "2026-07-01", "time": "2026-07-01T15:50:00"},
            {"low": 111, "high": 116, "close": 113, "source_count": 2, "session_date": "2026-07-02", "time": "2026-07-02T09:40:00"},
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


def test_mtf_signal_matches_ignores_single_candle_without_prior_mtf_touch():
    matches = mtf_signal_matches(
        113,
        "Bullish",
        [{"open": 111, "low": 99, "high": 113, "close": 113, "source_count": 1, "time": "2026-07-02T09:50:00"}],
        {"5": 116, "12": 114, "34": 100, "50": 110},
        {"34": 120, "50": 121},
        {"20": 122, "21": 123, "50": 124, "55": 125},
    )

    assert matches == []


def test_mtf_signal_matches_still_ignores_complete_single_candle_without_prior_mtf_touch():
    matches = mtf_signal_matches(
        113,
        "Bullish",
        [{"open": 111, "low": 99, "close": 113, "source_count": 2, "time": "2026-07-02T09:50:00"}],
        {"5": 116, "12": 114, "34": 100, "50": 110},
        {"34": 120, "50": 121},
        {"20": 122, "21": 123, "50": 124, "55": 125},
    )

    assert matches == []


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
