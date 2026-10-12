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


def test_levels_pick_nearest_two_each_side():
    chans = [(95, 96, 60), (104, 105, 60)]
    levels = levels_around(100, chans, [98, 102, 99.95])
    assert levels == {"s1": 99.95, "s2": 98, "r1": 102, "r2": 104}
