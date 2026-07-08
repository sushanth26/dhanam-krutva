from types import SimpleNamespace

import app.notifications as notifications
from app.notifications import (
    PushSubscriptionStore,
    build_monitored_quotes,
    confirmed_mtf_quotes,
    describe_mtf_matches,
    filter_payload_by_strategies,
    monitored_symbols,
    mtf_notification_payload,
    mtf_signature,
)
from app.watchlists import WatchlistStore


def test_push_subscription_store_upserts_and_removes_by_endpoint(tmp_path):
    store = PushSubscriptionStore(tmp_path / "subscriptions.json")
    first = {"endpoint": "https://push.example/1", "keys": {"p256dh": "a", "auth": "b"}}
    updated = {"endpoint": "https://push.example/1", "keys": {"p256dh": "c", "auth": "d"}}

    assert store.upsert(first) == 1
    assert store.upsert(updated) == 1
    assert store.all() == [updated]
    assert store.remove("https://push.example/1") == 0
    assert store.all() == []


def test_mtf_notification_payload_lists_symbols_and_clouds():
    quotes = [
        {"symbol": "BE", "mtf_matches": [{"label": "Hourly 34/50"}]},
        {"symbol": "LLY", "mtf_matches": [{"label": "Daily 20/21"}, {"label": "Daily 50/55"}]},
    ]

    payload = mtf_notification_payload(quotes)

    assert payload["title"] == "2 MTF alerts: BE, LLY"
    assert payload["body"] == "BE Hourly 34/50 • LLY Daily 20/21"
    assert payload["badgeCount"] == 2
    assert payload["badge_count"] == 2
    assert payload["targetSymbol"] == "BE"
    assert payload["url"] == "/?mtf=BE"
    assert payload["matches"][1]["labels"] == ["Daily 20/21", "Daily 50/55"]
    assert describe_mtf_matches(quotes) == "BE Hourly 34/50 | LLY Daily 20/21 + Daily 50/55"
    assert mtf_signature(list(reversed(quotes))) == mtf_signature(quotes)


def test_mtf_notification_payload_uses_rejection_wording_and_entry_price():
    quotes = [
        {
            "symbol": "AAOI",
            "mtf_matches": [
                {
                    "label": "10m bounce 34/50",
                    "display_label": "10m rejection 34/50",
                    "trade_action": "Short",
                    "entry_price": 104,
                }
            ],
        },
    ]

    payload = mtf_notification_payload(quotes)

    assert payload["title"] == "AAOI: 10m rejection 34/50 @ 104.00"
    assert payload["body"] == "Tap to open this MTF row."
    assert payload["matches"][0]["labels"] == ["10m bounce 34/50"]
    assert payload["matches"][0]["details"] == [
        {
            "label": "10m bounce 34/50",
            "display_label": "10m rejection 34/50",
            "entry_price": 104,
        }
    ]
    assert describe_mtf_matches(quotes) == "AAOI 10m rejection 34/50 @ 104.00"


def test_confirmed_mtf_quotes_removes_waiting_matches():
    quotes = [
        {
            "symbol": "BE",
            "mtf_matches": [
                {"label": "Hourly 34/50", "status": "waiting"},
                {"label": "Daily 50/55", "status": "confirmed"},
            ],
        },
        {"symbol": "LLY", "mtf_matches": [{"label": "Daily 20/21", "status": "waiting"}]},
    ]

    confirmed = confirmed_mtf_quotes(quotes)

    assert len(confirmed) == 1
    assert confirmed[0]["symbol"] == "BE"
    assert confirmed[0]["mtf_matches"] == [{"label": "Daily 50/55", "status": "confirmed"}]


def test_monitored_symbols_use_saved_watchlists_not_static_og(tmp_path):
    watchlist_file = tmp_path / "watchlists.json"
    WatchlistStore(watchlist_file).replace(
        [
            {"id": "og", "symbols": ["BE", "PLTR"]},
            {"name": "Daily", "symbols": ["PLTR", "NVDA"]},
        ]
    )
    settings = SimpleNamespace(watchlist_file=watchlist_file)

    assert monitored_symbols(settings) == ["BE", "PLTR", "NVDA"]


def test_build_monitored_quotes_omits_deleted_symbols(tmp_path, monkeypatch):
    watchlist_file = tmp_path / "watchlists.json"
    WatchlistStore(watchlist_file).replace([{"id": "og", "symbols": ["BE", "PLTR"]}])
    settings = SimpleNamespace(watchlist_file=watchlist_file)
    requested_symbols = []

    monkeypatch.setattr(notifications, "service", lambda: object())

    def fake_build_live_prices(_webull, symbols):
        requested_symbols.extend(symbols.split(","))
        return {"quotes": [{"symbol": symbol, "mtf_matches": []} for symbol in symbols.split(",")]}

    monkeypatch.setattr(notifications, "build_live_prices", fake_build_live_prices)

    quotes = build_monitored_quotes(settings)

    assert requested_symbols == ["BE", "PLTR"]
    assert "AAOI" not in requested_symbols
    assert [quote["symbol"] for quote in quotes] == ["BE", "PLTR"]


def test_filter_payload_by_strategies_removes_disabled_alerts():
    payload = {
        "title": "MTFs changed",
        "body": "old body",
        "matches": [
            {"symbol": "BE", "labels": ["Hourly 34/50", "10m bounce Hourly 34/50"]},
            {"symbol": "LLY", "labels": ["Daily 50/55"]},
        ],
    }

    filtered = filter_payload_by_strategies(
        payload,
        {"hourly-cloud": False, "daily-slow-cloud": True, "ten-minute-bounce-hourly": True},
    )

    assert filtered["title"] == "2 MTF alerts: BE, LLY"
    assert filtered["body"] == "BE 10m bounce Hourly 34/50 • LLY Daily 50/55"
    assert filtered["badgeCount"] == 2
    assert filtered["targetSymbol"] == "BE"
    assert filtered["url"] == "/?mtf=BE"
    assert filtered["matches"][0]["labels"] == ["10m bounce Hourly 34/50"]


def test_filter_payload_by_strategies_migrates_old_10m_touch_setting():
    payload = {
        "matches": [
            {"symbol": "BE", "labels": ["10m bounce 34/50"]},
        ],
    }

    assert filter_payload_by_strategies(payload, {"ten-minute-touch": False}) is None


def test_filter_payload_by_strategies_can_disable_10m_hourly_bounces_only():
    payload = {
        "matches": [
            {
                "symbol": "BE",
                "labels": [
                    "10m bounce 34/50",
                    "10m bounce Hourly 34/50",
                    "10m bounce Daily 20/21",
                    "10m bounce Daily 50/55",
                ],
            },
        ],
    }

    filtered = filter_payload_by_strategies(payload, {"ten-minute-bounce-hourly": False})

    assert filtered["matches"][0]["labels"] == [
        "10m bounce 34/50",
        "10m bounce Daily 20/21",
        "10m bounce Daily 50/55",
    ]


def test_filter_payload_by_strategies_can_disable_9ema_touch_only():
    payload = {
        "matches": [
            {"symbol": "BE", "labels": ["10m bounce 34/50", "10m 9 EMA touch"]},
        ],
    }

    filtered = filter_payload_by_strategies(payload, {"ten-minute-9ema-touch": False})

    assert filtered["matches"][0]["labels"] == ["10m bounce 34/50"]


def test_filter_payload_by_strategies_can_disable_daily_bounces_only():
    payload = {
        "matches": [
            {
                "symbol": "BE",
                "labels": [
                    "10m bounce 34/50",
                    "10m bounce Hourly 34/50",
                    "10m bounce Daily 20/21",
                    "10m bounce Daily 50/55",
                ],
            },
        ],
    }

    filtered = filter_payload_by_strategies(
        payload,
        {"ten-minute-bounce-daily-fast": False, "ten-minute-bounce-daily-slow": False},
    )

    assert filtered["matches"][0]["labels"] == [
        "10m bounce 34/50",
        "10m bounce Hourly 34/50",
    ]


def test_filter_payload_by_strategies_skips_push_when_all_alerts_disabled():
    payload = {
        "matches": [
            {"symbol": "BE", "labels": ["Hourly 34/50"]},
        ],
    }

    assert filter_payload_by_strategies(payload, {"hourly-cloud": False}) is None


def test_filter_payload_by_strategies_keeps_generic_test_payloads():
    payload = {"title": "MTF notification test", "body": "Testing"}

    assert filter_payload_by_strategies(payload, {"hourly-cloud": False}) == payload
