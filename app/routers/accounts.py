from fastapi import APIRouter, HTTPException, Query

from app.dependencies import service
from app.webull_service import WebullConfigurationError


router = APIRouter()


@router.get("/api/status")
def status():
    return service().status()


@router.get("/api/accounts")
def accounts():
    try:
        return service().account_list()
    except WebullConfigurationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/api/account/{account_id}/balance")
def balance(account_id: str):
    try:
        return service().account_balance(account_id)
    except WebullConfigurationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/api/account/{account_id}/positions")
def positions(account_id: str):
    try:
        return service().account_positions(account_id)
    except WebullConfigurationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/api/account/{account_id}/orders")
def orders(account_id: str, page_size: int = Query(default=10, ge=1, le=50), days: int = Query(default=30, ge=1, le=365)):
    try:
        return service().order_history(account_id, page_size=page_size, days=days)
    except WebullConfigurationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/api/snapshot")
def snapshot(account_id: str | None = Query(default=None)):
    try:
        return service().snapshot(account_id)
    except WebullConfigurationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
