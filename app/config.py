from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
import os


load_dotenv()


EnvironmentName = Literal["uat", "prod"]


WEBULL_ENDPOINTS = {
    "uat": "us-openapi-alb.uat.webullbroker.com",
    "prod": "api.webull.com",
}


@dataclass(frozen=True)
class Settings:
    app_key: str
    app_secret: str
    environment: EnvironmentName
    region: str
    access_token: str | None
    token_dir: Path | None
    app_username: str
    app_password: str | None
    vapid_public_key: str | None
    vapid_private_key: str | None
    vapid_subject: str
    push_subscription_file: Path
    watchlist_file: Path
    mtf_push_poll_seconds: int
    mtf_push_timezone: str

    @property
    def endpoint(self) -> str:
        return WEBULL_ENDPOINTS[self.environment]

    @property
    def configured(self) -> bool:
        return bool(self.app_key and self.app_secret)

    @property
    def auth_enabled(self) -> bool:
        return bool(self.app_password)

    @property
    def push_configured(self) -> bool:
        return bool(self.vapid_public_key and self.vapid_private_key)


def get_settings() -> Settings:
    raw_env = os.getenv("WEBULL_ENV", "uat").strip().lower()
    environment: EnvironmentName = "prod" if raw_env in {"prod", "production"} else "uat"
    token_dir = os.getenv("WEBULL_TOKEN_DIR") or default_token_dir()
    token_dir = token_dir.strip()

    return Settings(
        app_key=os.getenv("WEBULL_APP_KEY", "").strip(),
        app_secret=os.getenv("WEBULL_APP_SECRET", "").strip(),
        environment=environment,
        region=os.getenv("WEBULL_REGION", "us").strip().lower() or "us",
        access_token=os.getenv("WEBULL_ACCESS_TOKEN", "").strip() or None,
        token_dir=Path(token_dir) if token_dir else None,
        app_username=os.getenv("APP_USERNAME", "sushanth").strip() or "sushanth",
        app_password=os.getenv("APP_PASSWORD", "").strip() or None,
        vapid_public_key=os.getenv("VAPID_PUBLIC_KEY", "").strip() or None,
        vapid_private_key=os.getenv("VAPID_PRIVATE_KEY", "").strip() or None,
        vapid_subject=os.getenv("VAPID_SUBJECT", "mailto:sushanth@example.com").strip() or "mailto:sushanth@example.com",
        push_subscription_file=Path(os.getenv("PUSH_SUBSCRIPTION_FILE", "").strip() or default_push_subscription_file()),
        watchlist_file=Path(os.getenv("WATCHLIST_FILE", "").strip() or default_watchlist_file()),
        mtf_push_poll_seconds=max(30, int(os.getenv("MTF_PUSH_POLL_SECONDS", "60") or "60")),
        mtf_push_timezone=os.getenv("MTF_PUSH_TIMEZONE", "America/Chicago").strip() or "America/Chicago",
    )


def default_token_dir() -> str:
    if os.getenv("RAILWAY_ENVIRONMENT") or os.getenv("RAILWAY_PROJECT_ID"):
        return "/data/.webull-token"
    return ".webull-token"


def default_push_subscription_file() -> str:
    if os.getenv("RAILWAY_ENVIRONMENT") or os.getenv("RAILWAY_PROJECT_ID"):
        return "/data/push-subscriptions.json"
    return ".web-push-subscriptions.json"


def default_watchlist_file() -> str:
    if os.getenv("RAILWAY_ENVIRONMENT") or os.getenv("RAILWAY_PROJECT_ID"):
        return "/data/watchlists.json"
    return ".watchlists.json"
