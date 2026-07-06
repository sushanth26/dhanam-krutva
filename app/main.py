from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.responses import Response

from app.auth import is_authorized
from app.config import get_settings
from app.notifications import MtfPushMonitor
from app.routers import accounts, notifications, strategy, trade, tradingview, webull


STATIC_DIR = Path("app/static")
INDEX_FILE = STATIC_DIR / "index.html"
NO_STORE_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
}
STATIC_REVALIDATE_FILES = {"sw.js", "manifest.webmanifest"}


class AppStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope) -> Response:
        response = await super().get_response(path, scope)
        if path in STATIC_REVALIDATE_FILES:
            response.headers.update(NO_STORE_HEADERS)
        elif path.startswith("assets/"):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


app = FastAPI(title="Dhanam Krutva Webull Dashboard")
app.mount("/static", AppStaticFiles(directory=STATIC_DIR), name="static")
app.include_router(accounts.router)
app.include_router(notifications.router)
app.include_router(webull.router)
app.include_router(strategy.router)
app.include_router(tradingview.router)
app.include_router(trade.router)


@app.on_event("startup")
async def start_mtf_push_monitor():
    app.state.mtf_push_monitor = MtfPushMonitor(get_settings())
    app.state.mtf_push_monitor.start()


@app.on_event("shutdown")
async def stop_mtf_push_monitor():
    monitor = getattr(app.state, "mtf_push_monitor", None)
    if monitor:
        await monitor.stop()


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
    return FileResponse(INDEX_FILE, headers=NO_STORE_HEADERS)


@app.get("/{path:path}", include_in_schema=False)
def spa_fallback(path: str) -> FileResponse:
    return FileResponse(INDEX_FILE, headers=NO_STORE_HEADERS)
