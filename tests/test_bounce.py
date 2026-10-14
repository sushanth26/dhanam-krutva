from datetime import datetime, timedelta

from app.bounce import ET, bounce_alerts, levels_around


def bar(start: datetime, o: float, h: float, l: float, c: float) -> dict:
    return {"sort_time": start.isoformat(), "open": o, "high": h, "low": l, "close": c, "source_count": 2}


def setup_history(session: datetime):
    hourly = [bar(session - timedelta(hours=80 - k), 100, 100.5, 99.5, 100) for k in range(70)]
    daily = [bar(session - timedelta(days=120 - k), 50, 51, 49, 50) for k in range(110)]
    ten = []
    start = session.replace(hour=9, minute=30)
    for k in range(8):  # 09:30-10:50 above the 1H cloud
        ten.append(bar(start + timedelta(minutes=10 * k), 102, 102.4, 101.8, 102.2))
    return ten, hourly, daily


def test_bounce_off_hourly_cloud_alerts_with_entry_stop_and_levels():
    session = datetime(2026, 10, 9, tzinfo=ET)
    ten, hourly, daily = setup_history(session)
    tag = session.replace(hour=10, minute=50)
    ten.append(bar(tag, 101.2, 101.6, 100.05, 101.5))  # tags the cloud, closes back above, green
    alerts = bounce_alerts("MU", ten, ten, hourly, daily, now=session.replace(hour=11, minute=5))

    assert len(alerts) == 1
    alert = alerts[0]
    assert alert["side"] == "long"
    assert alert["alert"] == "Bounce 1H 34/50"
    assert alert["premarket"] is False
    assert alert["time"] == "10:50"  # candle open
    assert alert["entry"] == 101.5
    assert alert["stop"] < 100  # beyond the cloud
    assert set(alert) >= {"s1", "s2", "r1", "r2"}


def test_near_miss_is_not_a_tag():
    session = datetime(2026, 10, 9, tzinfo=ET)
    ten, hourly, daily = setup_history(session)
    ten.append(bar(session.replace(hour=10, minute=50), 101.2, 101.6, 100.4, 101.5))  # never reaches 100
    assert bounce_alerts("MU", ten, ten, hourly, daily, now=session.replace(hour=11, minute=5)) == []


def test_open_bar_is_never_alerted():
    session = datetime(2026, 10, 9, tzinfo=ET)
    ten, hourly, daily = setup_history(session)
    ten.append(bar(session.replace(hour=10, minute=50), 101.2, 101.6, 100.05, 101.5))
    assert bounce_alerts("MU", ten, ten, hourly, daily, now=session.replace(hour=10, minute=55)) == []


def test_premarket_bounce_alerts_from_830_with_pm_label():
    session = datetime(2026, 10, 9, tzinfo=ET)
    hourly = [bar(session - timedelta(hours=80 - k), 100, 100.5, 99.5, 100) for k in range(70)]
    daily = [bar(session - timedelta(days=120 - k), 50, 51, 49, 50) for k in range(110)]
    start = session.replace(hour=7, minute=40)
    ten = [bar(start + timedelta(minutes=10 * k), 102, 102.4, 101.8, 102.2) for k in range(5)]  # 07:40-08:20
    ten.append(bar(session.replace(hour=8, minute=30), 101.2, 101.6, 100.05, 101.5))

    alerts = bounce_alerts("MU", ten, ten, hourly, daily, now=session.replace(hour=8, minute=45))

    assert [a["alert"] for a in alerts] == ["PM Bounce 1H 34/50"]
    assert alerts[0]["premarket"] is True
    assert alerts[0]["time"] == "08:30"


def test_no_premarket_alert_before_830():
    session = datetime(2026, 10, 9, tzinfo=ET)
    hourly = [bar(session - timedelta(hours=80 - k), 100, 100.5, 99.5, 100) for k in range(70)]
    daily = [bar(session - timedelta(days=120 - k), 50, 51, 49, 50) for k in range(110)]
    start = session.replace(hour=7, minute=20)
    ten = [bar(start + timedelta(minutes=10 * k), 102, 102.4, 101.8, 102.2) for k in range(5)]  # 07:20-08:00
    ten.append(bar(session.replace(hour=8, minute=10), 101.2, 101.6, 100.05, 101.5))  # closes 08:20

    assert bounce_alerts("MU", ten, ten, hourly, daily, now=session.replace(hour=8, minute=45)) == []


def test_levels_pick_nearest_two_each_side():
    chans = [(95, 96, 60), (104, 105, 60)]
    levels = levels_around(100, chans, [98, 102, 99.95])
    assert levels == {"s1": 99.95, "s2": 98, "r1": 102, "r2": 104}


def test_bounce_alerts_are_tagged_with_their_watchlists(tmp_path, monkeypatch):
    from types import SimpleNamespace

    from app import notifications
    from app.watchlists import WatchlistStore

    path = tmp_path / "watchlists.json"
    WatchlistStore(path).replace([
        {"id": "og", "name": "OG list", "symbols": ["MU", "BE"]},
        {"name": "Memory", "symbols": ["MU"]},
    ])
    monkeypatch.setattr(notifications, "_bounce_cache", {"at": 0.0, "alerts": [], "updated_at": None})
    monkeypatch.setattr(notifications, "build_monitored_quotes", lambda settings: [
        {"symbol": "MU", "bounce_alerts": [{"id": "a", "symbol": "MU", "bar_close": "2026-10-12T10:00:00-04:00"}]},
    ])
    result = notifications.latest_bounce_alerts(SimpleNamespace(watchlist_file=path))
    assert result["alerts"][0]["watchlists"] == ["OG list", "Memory"]


def test_feedback_marks_keep_the_alert_and_can_be_cleared(tmp_path):
    from app.feedback import FeedbackStore

    store = FeedbackStore(tmp_path / "feedback.json")
    alert = {"id": "MU|2026-10-09T11:00:00-04:00|long|1H 34/50", "symbol": "MU", "entry": 101.5, "verdict": None}
    store.mark(alert, "choppy")
    item = store.all()[alert["id"]]
    assert item["verdict"] == "choppy"
    assert item["alert"]["entry"] == 101.5 and "verdict" not in item["alert"]
    assert store.verdicts() == {alert["id"]: "choppy"}

    store.mark(alert, None)
    assert store.all() == {}
    try:
        store.mark(alert, "great")
    except ValueError:
        pass
    else:
        raise AssertionError("bad verdict accepted")


def test_stop_sits_just_past_the_alert_candle():
    session = datetime(2026, 10, 9, tzinfo=ET)
    ten, hourly, daily = setup_history(session)
    ten.append(bar(session.replace(hour=10, minute=50), 101.2, 101.6, 100.05, 101.5))
    alert = bounce_alerts("MU", ten, ten, hourly, daily, now=session.replace(hour=11, minute=5))[0]
    assert 99.9 < alert["stop"] < 100.05  # below the candle low by a small ATR pad
    assert alert["exit"] is None  # still in the trade


def test_exit_when_a_candle_closes_below_the_512():
    session = datetime(2026, 10, 9, tzinfo=ET)
    ten, hourly, daily = setup_history(session)
    ten.append(bar(session.replace(hour=10, minute=50), 101.2, 101.6, 100.05, 101.5))
    ten.append(bar(session.replace(hour=11, minute=0), 101.5, 103.0, 101.4, 102.9))  # runs
    ten.append(bar(session.replace(hour=11, minute=10), 102.9, 103.0, 101.0, 101.2))  # closes below the 5/12
    alert = bounce_alerts("MU", ten, ten, hourly, daily, now=session.replace(hour=11, minute=25))[0]
    ex = alert["exit"]
    assert ex["reason"] == "512" and ex["label"] == "5/12 lost"
    assert ex["time"] == "11:10" and ex["price"] == 101.2
    assert ex["r"] < 0


def test_stop_hit_ends_the_trade_at_the_stop():
    session = datetime(2026, 10, 9, tzinfo=ET)
    ten, hourly, daily = setup_history(session)
    ten.append(bar(session.replace(hour=10, minute=50), 101.2, 101.6, 100.05, 101.5))
    ten.append(bar(session.replace(hour=11, minute=0), 101.5, 101.6, 99.0, 99.5))
    alert = bounce_alerts("MU", ten, ten, hourly, daily, now=session.replace(hour=11, minute=15))[0]
    assert alert["exit"]["reason"] == "stop"
    assert alert["exit"]["price"] == alert["stop"]
    assert alert["exit"]["r"] == -1.0


def test_alert_skipped_when_stop_would_be_over_3pct_away():
    session = datetime(2026, 10, 9, tzinfo=ET)
    ten, hourly, daily = setup_history(session)
    ten.append(bar(session.replace(hour=10, minute=50), 99.0, 101.6, 95.0, 101.5))  # huge wick through the cloud
    assert bounce_alerts("MU", ten, ten, hourly, daily, now=session.replace(hour=11, minute=5)) == []
