from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import get_settings
from app.notifications import MtfPushMonitor, PushSubscriptionStore


router = APIRouter(prefix="/api/notifications")


class PushSubscriptionPayload(BaseModel):
    subscription: dict[str, Any]


@router.get("/config")
def notification_config():
    settings = get_settings()
    return {
        "web_push_configured": settings.push_configured,
        "vapid_public_key": settings.vapid_public_key,
        "poll_seconds": settings.mtf_push_poll_seconds,
    }


@router.post("/subscribe")
def subscribe(payload: PushSubscriptionPayload):
    endpoint = payload.subscription.get("endpoint")
    keys = payload.subscription.get("keys")
    if not endpoint or not isinstance(keys, dict):
        raise HTTPException(status_code=400, detail="Invalid push subscription.")

    settings = get_settings()
    total = PushSubscriptionStore(settings.push_subscription_file).upsert(payload.subscription)
    return {"ok": True, "subscriptions": total}


@router.post("/test")
def test_notification():
    settings = get_settings()
    if not settings.push_configured:
        raise HTTPException(status_code=400, detail="Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to enable Web Push.")

    result = MtfPushMonitor(settings).send(
        {
            "title": "MTF notification test",
            "body": "BE Hourly 34/50 | AAOI Daily 20/21 | LLY Daily 50/55",
            "tag": "mtf-test",
            "url": "/",
        }
    )
    return {"ok": True, **result}
