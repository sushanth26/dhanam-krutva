from app.config import get_settings


def test_mtf_push_polling_defaults_on(monkeypatch):
    monkeypatch.delenv("MTF_PUSH_ENABLED", raising=False)

    assert get_settings().mtf_push_enabled is True


def test_mtf_push_polling_can_be_disabled(monkeypatch):
    monkeypatch.setenv("MTF_PUSH_ENABLED", "false")

    assert get_settings().mtf_push_enabled is False
