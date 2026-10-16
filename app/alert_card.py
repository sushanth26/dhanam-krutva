"""Eye-catching image for a Telegram alert: the company logo and the ticker on a coloured card
(green bounce, red reject, amber watch). Any failure returns None and the alert goes out as text."""

from __future__ import annotations

import io
import logging
import urllib.request
from typing import Any

logger = logging.getLogger(__name__)

LOGO_URL = "https://assets.parqet.com/logos/symbol/{symbol}?format=png"
COLORS = {"long": (22, 163, 74), "short": (220, 38, 38), "watch": (217, 119, 6)}
WIDTH, HEIGHT = 900, 360
_logos: dict[str, bytes | None] = {}


def _logo(symbol: str) -> bytes | None:
    if symbol not in _logos:
        try:
            req = urllib.request.Request(LOGO_URL.format(symbol=symbol), headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=4) as response:
                _logos[symbol] = response.read() if response.status == 200 else None
        except Exception:
            _logos[symbol] = None
    return _logos[symbol]


def alert_card(alert: dict[str, Any]) -> bytes | None:
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return None
    try:
        symbol = alert["symbol"]
        color = COLORS["watch"] if alert.get("watch") else COLORS.get(alert.get("side", "long"), COLORS["long"])
        img = Image.new("RGB", (WIDTH, HEIGHT), color)
        draw = ImageDraw.Draw(img)
        x = 48
        raw = _logo(symbol)
        if raw:
            logo = Image.open(io.BytesIO(raw)).convert("RGBA")
            scale = 200 / max(logo.width, logo.height)  # source logos are small: scale up to fill
            logo = logo.resize((max(1, round(logo.width * scale)), max(1, round(logo.height * scale))), Image.LANCZOS)
            plate = Image.new("RGBA", (232, 232), (255, 255, 255, 255))
            plate.paste(logo, ((232 - logo.width) // 2, (232 - logo.height) // 2), logo)
            img.paste(plate.convert("RGB"), (x, (HEIGHT - 232) // 2))
            x += 232 + 40
        size = 150 if len(symbol) <= 4 else 120
        draw.text((x, 70), symbol, fill="white", font=ImageFont.load_default(size=size))
        draw.text((x + 4, 240), alert.get("alert", ""), fill="white", font=ImageFont.load_default(size=44))
        out = io.BytesIO()
        img.save(out, format="PNG")
        return out.getvalue()
    except Exception:
        logger.exception("Alert card failed for %s", alert.get("symbol"))
        return None
