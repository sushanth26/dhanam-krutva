from types import SimpleNamespace

import app.notifications as notifications
from app.notifications import (
    MtfPushMonitor,
    PushSubscriptionStore,
    apply_enabled_strategies,
    build_monitored_quotes,
    confirmed_mtf_quotes,
    describe_mtf_matches,
    monitored_symbols,
    mtf_notification_payload,
    mtf_signature,
    save_push_alert_history,
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


def test_mtf_push_monitor_does_not_start_when_disabled(tmp_path):
    settings = SimpleNamespace(
        push_configured=True,
        mtf_push_enabled=False,
        push_subscription_file=tmp_path / "subscriptions.json",
    )
    monitor = MtfPushMonitor(settings)

    monitor.start()

    assert monitor.task is None


def test_apply_enabled_strategies_drops_matches_for_disabled_strategy_and_empties_quote():
    quotes = [
        {
            "symbol": "MU",
            "mtf_matches": [
                {"type": "mtf_cloud_price_touch", "label": "Hourly 34/50"},
                {"type": "long_mtf_5_12_touch", "label": "Curl"},
            ],
        },
        {"symbol": "BE", "mtf_matches": [{"type": "mtf_cloud_price_touch", "label": "Daily 20/21"}]},
    ]

    filtered = apply_enabled_strategies(quotes, {"mtfCloudTouch": False, "curls": True})

    assert [quote["symbol"] for quote in filtered] == ["MU"]
    assert [match["type"] for match in filtered[0]["mtf_matches"]] == ["long_mtf_5_12_touch"]


def test_save_push_alert_history_persists_background_alerts(tmp_path):
    settings = SimpleNamespace(alert_history_file=tmp_path / "alerts.sqlite3")
    quotes = [
        {
            "symbol": "MU",
            "price": 92.5,
            "mtf_matches": [
                {
                    "type": "mtf_cloud_price_touch",
                    "display_label": "Hourly 34/50 Touch",
                    "candle_time": "2026-07-13T14:10:00",
                    "cloud_label": "Hourly 34/50",
                }
            ],
        }
    ]

    alerts = save_push_alert_history(settings, quotes)

    assert len(alerts) == 1
    assert alerts[0]["symbol"] == "MU"
    assert alerts[0]["watchlist"]["id"] == "push-monitor"
    assert alerts[0]["match"]["type"] == "mtf_cloud_price_touch"


def test_mtf_notification_payload_lists_symbols_and_clouds():
    quotes = [
        {"symbol": "BE", "mtf_matches": [{"label": "Hourly 34/50"}]},
        {"symbol": "LLY", "mtf_matches": [{"label": "Daily 20/21"}, {"label": "Daily 50/55"}]},
    ]

    payload = mtf_notification_payload(quotes)

    assert payload["title"] == "2 Setup alerts: BE, LLY"
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
    assert payload["body"] == "Tap to open this setup row."
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
                {"label": "Daily 20/21", "status": "waiting", "type": "mtf_cloud_inside"},
                {"label": "Daily 50/55", "status": "confirmed"},
            ],
        },
        {"symbol": "LLY", "mtf_matches": [{"label": "Daily 20/21", "status": "waiting"}]},
    ]

    confirmed = confirmed_mtf_quotes(quotes)

    assert len(confirmed) == 1
    assert confirmed[0]["symbol"] == "BE"
    assert confirmed[0]["mtf_matches"] == [
        {"label": "Daily 20/21", "status": "waiting", "type": "mtf_cloud_inside"},
        {"label": "Daily 50/55", "status": "confirmed"},
    ]


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
