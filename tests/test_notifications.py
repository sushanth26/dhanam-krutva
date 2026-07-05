from app.notifications import (
    PushSubscriptionStore,
    describe_mtf_matches,
    filter_payload_by_strategies,
    mtf_notification_payload,
    mtf_signature,
)


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

    assert payload["title"] == "MTFs changed"
    assert payload["body"] == "BE Hourly 34/50 | LLY Daily 20/21 + Daily 50/55"
    assert payload["badgeCount"] == 2
    assert payload["badge_count"] == 2
    assert payload["matches"][1]["labels"] == ["Daily 20/21", "Daily 50/55"]
    assert describe_mtf_matches(quotes) in payload["body"]
    assert mtf_signature(list(reversed(quotes))) == mtf_signature(quotes)


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

    assert filtered["body"] == "BE 10m bounce Hourly 34/50 | LLY Daily 50/55"
    assert filtered["badgeCount"] == 2
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
