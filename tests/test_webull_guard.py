from pathlib import Path

from app.config import Settings
from app.webull_service import WebullService


def settings(tmp_path: Path) -> Settings:
    return Settings(
        app_key="key",
        app_secret="secret",
        environment="prod",
        region="us",
        access_token=None,
        token_dir=tmp_path / "token",
        app_username="tester",
        app_password="secret",
        vapid_public_key=None,
        vapid_private_key=None,
        vapid_subject="mailto:test@example.com",
        push_subscription_file=tmp_path / "push.json",
        alert_history_file=tmp_path / "alerts.json",
        watchlist_file=tmp_path / "watchlists.json",
        webull_guard_enabled=True,
        webull_guard_file=tmp_path / "webull-guard.json",
        webull_verify_cooldown_seconds=3600,
        webull_rate_limit_cooldown_seconds=300,
        mtf_push_poll_seconds=300,
        mtf_push_timezone="America/Chicago",
    )


def test_verify_failure_activates_webull_guard(tmp_path):
    service = WebullService(settings(tmp_path))

    result = service._guarded_result(
        {
            "ok": False,
            "status_code": 417,
            "request_id": "request-1",
            "error_code": "VERIFY_FAILURE_EXCEED_LIMIT",
            "error": "verification failed too many times",
        }
    )

    assert result["webull_guard_active"] is True
    assert result["webull_guard_reason"] == "verification"
    assert service.status()["webull_guard"]["active"] is True


def test_active_webull_guard_blocks_future_sdk_calls(tmp_path):
    service = WebullService(settings(tmp_path))
    service._guarded_result(
        {
            "ok": False,
            "status_code": 429,
            "request_id": "request-2",
            "error_code": "TOO_MANY_REQUESTS",
            "error": "Too many requests",
        }
    )

    def should_not_call():
        raise AssertionError("guarded Webull call should not reach the SDK")

    result = service._call(should_not_call)

    assert result["ok"] is False
    assert result["status_code"] == 423
    assert result["error_code"] == "WEBULL_GUARD_ACTIVE"
    assert result["webull_guard_reason"] == "rate_limit"


def test_disabled_webull_guard_does_not_block_future_sdk_calls(tmp_path):
    disabled_settings = settings(tmp_path)
    disabled_settings = Settings(
        **{
            **disabled_settings.__dict__,
            "webull_guard_enabled": False,
        }
    )
    service = WebullService(disabled_settings)
    service._guarded_result(
        {
            "ok": False,
            "status_code": 429,
            "request_id": "request-3",
            "error_code": "TOO_MANY_REQUESTS",
            "error": "Too many requests",
        }
    )

    class FakeResponse:
        status_code = 200
        headers = {}

        def json(self):
            return {"ok": True}

    result = service._call(lambda: FakeResponse())

    assert service.status()["webull_guard_enabled"] is False
    assert result["ok"] is True
