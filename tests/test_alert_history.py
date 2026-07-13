from app.alert_history import AlertHistoryStore


def test_alert_history_store_upserts_without_deleting_old_alerts(tmp_path):
    store = AlertHistoryStore(tmp_path / "alerts.json")
    first = {
        "watchlist": {"id": "og", "name": "OG list"},
        "quote": {"symbol": "SNDK"},
        "match": {
            "type": "10m_34_50_bounce",
            "display_label": "Good 34/50 Bounce",
            "candle_time": "2026-07-13T13:50:00",
            "cloud_label": "10m 34/50",
        },
    }
    second = {
        "watchlist": {"id": "og", "name": "OG list"},
        "quote": {"symbol": "MRVL"},
        "match": {
            "type": "10m_34_50_bounce",
            "display_label": "Bad 34/50 Bounce",
            "candle_time": "2026-07-13T14:10:00",
            "cloud_label": "10m 34/50",
        },
    }

    assert len(store.upsert_many([first])) == 1
    assert len(store.upsert_many([first, second])) == 2
    assert [alert["symbol"] for alert in store.all()] == ["SNDK", "MRVL"]
