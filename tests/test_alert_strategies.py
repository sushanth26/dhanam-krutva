from app.alert_strategies import (
    AlertStrategySettingsStore,
    default_alert_strategies,
    filter_enabled_matches,
    match_enabled,
)


def test_default_alert_strategies_are_all_enabled():
    assert default_alert_strategies() == {
        "scannerEntry": True,
        "curls": True,
        "tenMinute3450Bounce": True,
        "mtfCloudTouch": True,
    }


def test_alert_strategy_settings_store_returns_defaults_when_missing(tmp_path):
    store = AlertStrategySettingsStore(tmp_path / "alert-strategies.json")

    assert store.get() == default_alert_strategies()


def test_alert_strategy_settings_store_persists_only_known_keys(tmp_path):
    store = AlertStrategySettingsStore(tmp_path / "alert-strategies.json")

    saved = store.save({"scannerEntry": False, "mtfCloudTouch": False, "unknownKey": False})

    assert saved == {"scannerEntry": False, "curls": True, "tenMinute3450Bounce": True, "mtfCloudTouch": False}
    assert store.get() == saved


def test_match_enabled_defaults_true_for_unrecognized_match_types():
    assert match_enabled({"type": "something_else"}, {"curls": False}) is True


def test_match_enabled_respects_disabled_strategy():
    assert match_enabled({"type": "mtf_cloud_price_touch"}, {"mtfCloudTouch": False}) is False
    assert match_enabled({"type": "mtf_cloud_price_touch"}, {"mtfCloudTouch": True}) is True
    assert match_enabled({"type": "scanner_entry"}, {"scannerEntry": False}) is False
    assert match_enabled({"type": "scanner_entry"}, {"scannerEntry": True}) is True


def test_filter_enabled_matches_drops_disabled_strategy_matches():
    matches = [
        {"type": "mtf_cloud_price_touch", "label": "Hourly 34/50"},
        {"type": "long_mtf_5_12_touch", "label": "Curl"},
    ]

    filtered = filter_enabled_matches(matches, {"mtfCloudTouch": False, "curls": True})

    assert [match["type"] for match in filtered] == ["long_mtf_5_12_touch"]
