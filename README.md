# Dhanam Krutva

Read-only Webull account dashboard for connection testing. This first version does not place, preview, modify, or cancel trades.

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
```

Edit `.env` with your Webull OpenAPI credentials.

This project installs Webull's SDK from your downloaded folder:

```text
/Users/sushanth/Downloads/webull-openapi-python-sdk-main
```

For Webull UAT testing, Webull publishes shared test credentials in the official SDK docs. Set `WEBULL_ENV=uat`. For your real account, set `WEBULL_ENV=prod` and use your production app key/secret.

## Run

```bash
.venv/bin/uvicorn app.main:app --reload --port 8000
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000).

## Railway Personal Deploy

This app is safe to start as a personal Railway deploy because Webull credentials
stay server-side and the browser only calls this FastAPI backend.

1. Create a Railway project from this GitHub repo.
2. Add a persistent volume mounted at `/data` if you want the Webull SDK token
   cache to survive restarts.
3. Set these Railway variables:

```text
WEBULL_APP_KEY=...
WEBULL_APP_SECRET=...
WEBULL_ENV=prod
WEBULL_REGION=us
WEBULL_TOKEN_DIR=/data/.webull-token
APP_USERNAME=sushanth
APP_PASSWORD=<strong private password>
```

Railway will use `Procfile` to run:

```bash
uvicorn app.main:app --host 0.0.0.0 --port $PORT
```

The `/health` endpoint is intentionally public for Railway health checks. All
other routes are protected with HTTP Basic Auth when `APP_PASSWORD` is set.

## What It Checks

- SDK client initialization and Webull authentication.
- Account list through `/openapi/account/list`.
- Account balance through `/openapi/assets/balance`.
- Account positions through `/openapi/assets/positions`.

## Safety Notes

- Credentials stay on the server and are never sent to the browser.
- `.env`, SDK token cache, virtualenvs, and Webull SDK logs are ignored by Git.
- Set `APP_PASSWORD` before deploying publicly.
- Trading endpoints are still server-side and should only be used behind your
  private app login.
