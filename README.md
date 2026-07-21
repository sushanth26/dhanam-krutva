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
MTF_PUSH_ENABLED=true
MTF_PUSH_POLL_SECONDS=60
MTF_PUSH_TIMEZONE=America/Chicago
```

`MTF_PUSH_ENABLED` defaults to true when omitted, so use
`MTF_PUSH_ENABLED=false` only when you intentionally want Railway push polling
off while keeping manual notification checks available. `MTF_PUSH_POLL_SECONDS`
defaults to 60, so the backend checks for push alerts once per minute during
weekdays from 3:00 AM through 5:59 PM in `MTF_PUSH_TIMEZONE`.

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

## Strategy Rules

| Strategy | Entry rule | Exit rule |
| --- | --- | --- |
| Hourly 34/50 | Alert when price closes out of the hourly 34/50 EMA cloud after being inside/beyond it. Long above cloud, short below cloud. | Target is 1:1 from entry to SL. Long SL is $3 below the hourly 34/50 cloud; short SL is $3 above it. |
| Daily 20/21 | Alert when price closes out of the daily 20/21 EMA cloud. Long above cloud, short below cloud. | Target is 1:1 from entry to SL. Long SL is $3 below the daily 20/21 cloud; short SL is $3 above it. |
| Daily 50/55 | Alert when price closes out of the daily 50/55 EMA cloud. Long above cloud, short below cloud. | Target is 1:1 from entry to SL. Long SL is $3 below the daily 50/55 cloud; short SL is $3 above it. |
| 10m bounce/rejection 34/50 | Enter only after a 10m candle touches the 10m 34/50 cloud and closes back above it for long, or below it for short. | Target is 1:1. Long SL below 10m 34/50 cloud; short SL above 10m 34/50 cloud. |
| 10m 9 EMA touch | From 9:30-10:30 ET, alert/trade when bullish 10m trend touches the 9 EMA. After 10:30 ET, only if one of the recent 4 prior 10m candles touched the 10m 34/50 cloud. | Target is 1:1. SL below 10m 34/50 cloud. |
| 10m 40 EMA touch | Alert/trade when bullish 10m trend touches the 40 EMA. | Target is 1:1. SL below 10m 34/50 cloud. |
| 10m bounce/rejection 1hr 34/50 | Alert when a 10m candle touches the hourly 34/50 cloud and closes back in the trend direction. | Target is 1:1. Long SL below 10m 34/50 cloud; short SL above the touched cloud. |
| 10m bounce/rejection Daily 20/21 | Alert when a 10m candle touches the daily 20/21 cloud and closes back in the trend direction. | Target is 1:1. Long SL below 10m 34/50 cloud; short SL above the touched cloud. |
| 10m bounce/rejection Daily 50/55 | Alert when a 10m candle touches the daily 50/55 cloud and closes back in the trend direction. | Target is 1:1. Long SL below 10m 34/50 cloud; short SL above the touched cloud. |

Alerts added to the MTF table are tracked in the Alert Log until price hits the
Target or SL.

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
