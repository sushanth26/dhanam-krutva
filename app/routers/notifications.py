from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.config import get_settings
from app.notifications import AlertHistoryStore, MtfPushMonitor, PushSubscriptionStore


router = APIRouter(prefix="/api/notifications")


class PushSubscriptionPayload(BaseModel):
    subscription: dict[str, Any]
    alert_strategies: dict[str, Any] | None = None


class PushUnsubscribePayload(BaseModel):
    endpoint: str


class NotificationHistoryPayload(BaseModel):
    item: dict[str, Any] | None = None
    items: list[dict[str, Any]] | None = None


@router.get("/config")
def notification_config():
    settings = get_settings()
    return {
        "web_push_configured": settings.push_configured,
        "vapid_public_key": settings.vapid_public_key,
        "poll_seconds": settings.mtf_push_poll_seconds,
    }


@router.post("/check")
def check_notifications(request: Request):
    settings = get_settings()
    monitor = getattr(request.app.state, "mtf_push_monitor", None)
    if monitor is None:
        monitor = MtfPushMonitor(settings)
    try:
        notification = monitor.check_once(manual=True)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"ok": True, "notification": notification, "monitor": monitor.status()}


@router.post("/subscribe")
def subscribe(payload: PushSubscriptionPayload):
    endpoint = payload.subscription.get("endpoint")
    keys = payload.subscription.get("keys")
    if not endpoint or not isinstance(keys, dict):
        raise HTTPException(status_code=400, detail="Invalid push subscription.")

    settings = get_settings()
    subscription = {
        **payload.subscription,
        "alert_strategies": payload.alert_strategies or {},
    }
    total = PushSubscriptionStore(settings.push_subscription_file).upsert(subscription)
    return {"ok": True, "subscriptions": total}


@router.post("/unsubscribe")
def unsubscribe(payload: PushUnsubscribePayload):
    settings = get_settings()
    total = PushSubscriptionStore(settings.push_subscription_file).remove(payload.endpoint)
    return {"ok": True, "subscriptions": total}


@router.get("/history")
def notification_history(limit: int = 500):
    settings = get_settings()
    safe_limit = min(max(limit, 1), 1000)
    return {"ok": True, "items": AlertHistoryStore(settings.alert_history_file).all(safe_limit)}


@router.post("/history")
def append_notification_history(payload: NotificationHistoryPayload):
    entries = []
    if payload.item:
        entries.append(payload.item)
    if payload.items:
        entries.extend(payload.items)
    settings = get_settings()
    items = AlertHistoryStore(settings.alert_history_file).append(entries)
    return {"ok": True, "items": items[:500]}


@router.delete("/history")
def clear_notification_history():
    settings = get_settings()
    AlertHistoryStore(settings.alert_history_file).clear()
    return {"ok": True, "items": []}


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
