from app.config import get_settings
from app.webull_service import WebullService


def service() -> WebullService:
    return WebullService(get_settings())
