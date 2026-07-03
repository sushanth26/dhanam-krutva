from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.auth import is_authorized
from app.config import get_settings
from app.routers import accounts, strategy, trade, tradingview, webull


STATIC_DIR = Path("app/static")
INDEX_FILE = STATIC_DIR / "index.html"


app = FastAPI(title="Dhanam Krutva Webull Dashboard")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.include_router(accounts.router)
app.include_router(webull.router)
app.include_router(strategy.router)
app.include_router(tradingview.router)
app.include_router(trade.router)


@app.middleware("http")
async def require_app_auth(request: Request, call_next):
    settings = get_settings()
    if not settings.auth_enabled or request.url.path == "/health":
        return await call_next(request)

    if is_authorized(request, settings.app_username, settings.app_password or ""):
        return await call_next(request)

    return JSONResponse(
        {"detail": "Authentication required."},
        status_code=401,
        headers={"WWW-Authenticate": 'Basic realm="Dhanam Krutva"'},
    )


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/")
def index() -> FileResponse:
    return FileResponse(INDEX_FILE)


@app.get("/{path:path}", include_in_schema=False)
def spa_fallback(path: str) -> FileResponse:
    return FileResponse(INDEX_FILE)
