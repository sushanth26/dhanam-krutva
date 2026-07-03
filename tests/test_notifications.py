from app.notifications import PushSubscriptionStore, describe_mtf_matches, mtf_notification_payload, mtf_signature


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
    assert payload["matches"][1]["labels"] == ["Daily 20/21", "Daily 50/55"]
    assert describe_mtf_matches(quotes) in payload["body"]
    assert mtf_signature(list(reversed(quotes))) == mtf_signature(quotes)
