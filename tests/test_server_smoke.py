import json
import os
import subprocess
import sys
import time
from base64 import b64encode
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
PORT = 8123
BASE_URL = f"http://127.0.0.1:{PORT}"


def auth_header(username: str = "tester", password: str = "secret") -> str:
    token = b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
    return f"Basic {token}"


def request(path: str, authorization: str | None = None):
    headers = {"Authorization": authorization} if authorization else {}
    return urlopen(Request(f"{BASE_URL}{path}", headers=headers), timeout=5)


def wait_for_server(process: subprocess.Popen):
    deadline = time.time() + 15
    while time.time() < deadline:
        if process.poll() is not None:
            raise AssertionError(f"server exited early with {process.returncode}")
        try:
            with request("/health") as response:
                if response.status == 200:
                    return
        except OSError:
            time.sleep(0.2)
    raise AssertionError("server did not become ready")


def test_uvicorn_serves_react_shell_and_protected_api():
    watchlist_file = ROOT / ".test-watchlists-smoke.json"
    alert_history_file = ROOT / ".test-alert-history-smoke.json"
    watchlist_file.unlink(missing_ok=True)
    alert_history_file.unlink(missing_ok=True)
    env = {
        **os.environ,
        "APP_USERNAME": "tester",
        "APP_PASSWORD": "secret",
        "WEBULL_APP_KEY": "",
        "WEBULL_APP_SECRET": "",
        "WEBULL_ACCESS_TOKEN": "",
        "WEBULL_TOKEN_DIR": "",
        "VAPID_PUBLIC_KEY": "",
        "VAPID_PRIVATE_KEY": "",
        "WATCHLIST_FILE": str(watchlist_file),
        "ALERT_HISTORY_FILE": str(alert_history_file),
        "PORT": str(PORT),
    }
    process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "app.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(PORT),
        ],
        cwd=ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        wait_for_server(process)

        with request("/health") as response:
            assert response.status == 200
            assert json.loads(response.read()) == {"ok": True}

        try:
            request("/")
        except HTTPError as error:
            assert error.code == 401
            assert error.headers["www-authenticate"] == 'Basic realm="Dhanam Krutva"'
        else:
            raise AssertionError("unauthenticated app shell request should fail")

        with request("/", auth_header()) as response:
            html = response.read().decode("utf-8")
            assert response.status == 200
            assert '<div id="root"></div>' in html
            assert "/static/assets/" in html
            assert response.headers["cache-control"] == "no-store, no-cache, must-revalidate, max-age=0"

        with request("/static/manifest.webmanifest", auth_header()) as response:
            manifest = json.loads(response.read())
            assert response.status == 200
            assert manifest["id"] == "/?app=dhanam-krutva"
            assert manifest["start_url"] == "/?app=dhanam-krutva"
            assert response.headers["cache-control"] == "no-store, no-cache, must-revalidate, max-age=0"

        with request("/static/sw.js", auth_header()) as response:
            assert response.status == 200
            assert response.headers["cache-control"] == "no-store, no-cache, must-revalidate, max-age=0"

        asset_path = html.split('src="')[1].split('"')[0]
        with request(asset_path, auth_header()) as response:
            assert response.status == 200
            assert response.headers["cache-control"] == "public, max-age=31536000, immutable"
            assert len(response.read()) > 1000

        with request("/api/status", auth_header()) as response:
            payload = json.loads(response.read())
            assert response.status == 200
            assert payload["configured"] is False
            assert payload["auth_enabled"] is True

        with request("/api/notifications/config", auth_header()) as response:
            payload = json.loads(response.read())
            assert response.status == 200
            assert payload["web_push_configured"] is False
            assert payload["vapid_public_key"] is None

        with request("/api/notifications/history", auth_header()) as response:
            payload = json.loads(response.read())
            assert response.status == 200
            assert payload == {"ok": True, "items": []}

        with request("/api/webull/watchlists", auth_header()) as response:
            payload = json.loads(response.read())
            assert response.status == 200
            assert payload["watchlists"][0]["id"] == "og"
            assert payload["watchlists"][0]["locked"] is True
    finally:
        watchlist_file.unlink(missing_ok=True)
        alert_history_file.unlink(missing_ok=True)
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
