# Dhanam Krutva

Read-only Webull account dashboard for connection testing. This first version does not place, preview, modify, or cancel trades.

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
npm --prefix frontend install
cp .env.example .env
```

Edit `.env` with your Webull OpenAPI credentials.

This project installs Webull's SDK from your downloaded folder:

```text
/Users/sushanth/Downloads/webull-openapi-python-sdk-main
```

For Webull UAT testing, Webull publishes shared test credentials in the official SDK docs. Set `WEBULL_ENV=uat`. For your real account, set `WEBULL_ENV=prod` and use your production app key/secret.

## Run

Production-style local run serves the built React app from FastAPI:

```bash
npm --prefix frontend run build
.venv/bin/uvicorn app.main:app --reload --port 8000
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000).

For frontend development, run FastAPI and Vite in separate terminals:

```bash
.venv/bin/uvicorn app.main:app --reload --port 8000
npm --prefix frontend run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). Vite proxies `/api`
requests to FastAPI.

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
WEBULL_GUARD_ENABLED=true
WEBULL_GUARD_FILE=/data/webull-guard.json
APP_USERNAME=sushanth
APP_PASSWORD=<strong private password>
```

`WEBULL_GUARD_ENABLED=false` is an emergency override for one controlled retry
when Webull support has reset a verification/rate-limit lock. Turn it back on
after the retry.

For phone app-style MTF push notifications, generate VAPID keys once:

```bash
npx web-push generate-vapid-keys
```

Then add these Railway variables:

```text
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com
PUSH_SUBSCRIPTION_FILE=/data/push-subscriptions.json
MTF_PUSH_POLL_SECONDS=60
MTF_PUSH_TIMEZONE=America/Chicago
```

After the first deploy, open the installed phone app, sign in, and tap
`Enable Notifications` once. Keep the same VAPID keys in Railway and keep
`PUSH_SUBSCRIPTION_FILE` on the `/data` volume. On later deploys, the phone app
automatically re-registers its service worker and re-syncs the push subscription
with Railway when it opens. The backend will poll Webull during the configured
market refresh window and send a push notification when the MTF table changes.

Railway uses `nixpacks.toml` to install Python dependencies, install the React
frontend with `npm ci`, build React into `app/static`, and run:

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
