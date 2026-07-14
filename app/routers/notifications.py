from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.alert_strategies import AlertStrategySettingsStore
from app.config import get_settings
from app.notifications import MtfPushMonitor, PushSubscriptionStore, is_market_refresh_window


router = APIRouter(prefix="/api/notifications")


class PushSubscriptionPayload(BaseModel):
    subscription: dict[str, Any]


class PushUnsubscribePayload(BaseModel):
    endpoint: str


class AlertStrategiesPayload(BaseModel):
    strategies: dict[str, bool]


@router.get("/config")
def notification_config(request: Request):
    settings = get_settings()
    monitor = getattr(request.app.state, "mtf_push_monitor", None)
    subscriptions = PushSubscriptionStore(settings.push_subscription_file).all()
    return {
        "web_push_configured": settings.push_configured,
        "mtf_push_enabled": settings.mtf_push_enabled,
        "vapid_public_key": settings.vapid_public_key,
        "poll_seconds": settings.mtf_push_poll_seconds,
        "subscriptions": len(subscriptions),
        "monitor_running": bool(monitor and monitor.task and not monitor.task.done()),
        "market_window": is_market_refresh_window(settings.mtf_push_timezone),
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


@router.post("/unsubscribe")
def unsubscribe(payload: PushUnsubscribePayload):
    settings = get_settings()
    total = PushSubscriptionStore(settings.push_subscription_file).remove(payload.endpoint)
    return {"ok": True, "subscriptions": total}


@router.get("/strategies")
def get_alert_strategies():
    settings = get_settings()
    return {"strategies": AlertStrategySettingsStore(settings.alert_strategy_file).get()}


@router.post("/strategies")
def save_alert_strategies(payload: AlertStrategiesPayload):
    settings = get_settings()
    return {"strategies": AlertStrategySettingsStore(settings.alert_strategy_file).save(payload.strategies)}


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
