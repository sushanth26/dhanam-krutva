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

    @property
    def endpoint(self) -> str:
        return WEBULL_ENDPOINTS[self.environment]

    @property
    def configured(self) -> bool:
        return bool(self.app_key and self.app_secret)

    @property
    def auth_enabled(self) -> bool:
        return bool(self.app_password)


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
    )


def default_token_dir() -> str:
    if os.getenv("RAILWAY_ENVIRONMENT") or os.getenv("RAILWAY_PROJECT_ID"):
        return "/data/.webull-token"
    return ".webull-token"
