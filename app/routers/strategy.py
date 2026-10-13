from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.config import get_settings
from app.feedback import FeedbackStore
from app.notifications import latest_bounce_alerts
from app.strategy import run_dry_run


router = APIRouter(prefix="/api/strategy")


@router.get("/dry-run")
def strategy_dry_run(symbols: str | None = Query(default=None)):
    selected_symbols = [symbol.strip().upper() for symbol in symbols.split(",")] if symbols else None
    return run_dry_run(selected_symbols)


@router.get("/bounces")
def strategy_bounces():
    try:
        settings = get_settings()
        result = latest_bounce_alerts(settings)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    verdicts = FeedbackStore(settings.feedback_file).verdicts()
    return {**result, "alerts": [{**alert, "verdict": verdicts.get(alert["id"])} for alert in result["alerts"]]}


class FeedbackPayload(BaseModel):
    alert: dict[str, Any]
    verdict: str | None = None


@router.get("/bounces/feedback")
def bounce_feedback():
    """Every marked alert with its verdict, for reviewing what worked."""
    return {"items": FeedbackStore(get_settings().feedback_file).all()}


@router.post("/bounces/feedback")
def mark_bounce(payload: FeedbackPayload):
    try:
        items = FeedbackStore(get_settings().feedback_file).mark(payload.alert, payload.verdict)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"id": payload.alert.get("id"), "verdict": payload.verdict, "count": len(items)}
