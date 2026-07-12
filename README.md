# Dhanam Krutva

Personal Webull dashboard and scanner for watchlists, 10-minute cloud trends, long-only setup alerts, account visibility, order history, and browser/phone notifications.

The browser talks only to this FastAPI backend. Webull credentials, token files, push subscriptions, and guard state stay server-side.

## Features

- **Scanner tab**
  - Live Webull price polling for saved watchlists.
  - Watchlist tabs with add/delete symbol controls.
  - Default OG list seeded with the current active symbols.
  - Symbols grouped by 10-minute cloud trend:
    - Bullish: 10m EMA 5/12 cloud above 10m EMA 34/50 cloud.
    - Bearish: 10m EMA 5/12 cloud below 10m EMA 34/50 cloud.
    - Chop: overlapping or incomplete cloud structure.
  - Risk settings for max risk, stop mode, and cloud buffer.
  - Per-watchlist "Do not auto trade" toggle.

- **MTFs tab**
  - Live long-only setup alert table.
  - Shows live setup count, Curl count, 10m 34/50 Bounce count, and unique symbols.
  - Each alert includes symbol, watchlist, setup, trend, entry, trigger, and alert candle time.

- **Curls**
  - A Curl is a good B setup where price touches an MTF cloud, then moves back above the 10m EMA 5/12 cloud.
  - The app first checks 10m cloud state using EMA 5/12 and EMA 34/50.
  - Curl alerts are allowed only when the 10m state is Bullish or Bearish.
  - During the same trading day, price must have touched at least one MTF cloud:
    - Hourly 34/50
    - Daily 20/21
    - Daily 50/55
  - The MTF touch only counts if that candle is still below the 10m EMA 5/12 cloud.
  - A Curl alert fires when the latest 10m candle moves up above the 10m EMA 5/12 cloud.
  - Curls are long-only even when the 10m state is Bearish.

- **10m 34/50 Bounce**
  - A separate long-only setup from Curls.
  - No MTF touch is required.
  - Price must touch/pull into the 10m EMA 34/50 cloud.
  - The 10m candle must be confirmed/closed.
  - The confirmed 10m candle must close back above the top of the 10m EMA 34/50 cloud.
  - The confirmed 10m candle must close above the prior confirmed 10m candle.
  - Old alert strategy toggles and the old Alerts tab were removed.

- **Notifications**
  - In-app notification drawer with unread badge.
  - Browser/device notifications for new setup alerts when enabled.
  - Optional Web Push support for closed-app phone notifications with VAPID keys.
  - Service worker and app badge support.

- **Trades tab**
  - Broker order history view for the selected margin account.
  - Table filters for all, buy, sell, open, and filled orders.
  - Shows order side, status, quantity, price details, and time.

- **Accounts and backend APIs**
  - Webull connection status.
  - Account list.
  - Balance, positions, orders, and snapshot endpoints.
  - Watchlists persisted server-side.
  - TradingView analysis endpoint for supported timeframes.
  - Server-side guarded trade endpoints for one-share buys and bracketed auto-long orders.

- **Safety**
  - HTTP Basic Auth can protect all routes except `/health`.
  - Webull guard cooldowns help avoid repeated verification/rate-limit lockouts.
  - Trading endpoints require approved watchlist symbols and a margin account.
  - `.env`, token caches, guard files, push subscriptions, and local generated state are ignored by Git.

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
npm --prefix frontend install
cp .env.example .env
```

Edit `.env` with your Webull OpenAPI credentials.

The frontend package expects Node `>=22.12.0`. Older Node versions may still build, but Vite prints a warning.

## Environment

Required for Webull:

```text
WEBULL_APP_KEY=...
WEBULL_APP_SECRET=...
WEBULL_ENV=prod
WEBULL_REGION=us
```

Use `WEBULL_ENV=uat` for Webull UAT testing with test credentials, or `WEBULL_ENV=prod` for a real account.

Recommended for any public deployment:

```text
APP_USERNAME=sushanth
APP_PASSWORD=<strong private password>
```

Optional local/server persistence:

```text
WEBULL_TOKEN_DIR=.webull-token
WATCHLIST_FILE=.watchlists.json
WEBULL_GUARD_ENABLED=true
WEBULL_GUARD_FILE=.webull-guard.json
```

Optional Web Push:

```text
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com
PUSH_SUBSCRIPTION_FILE=.web-push-subscriptions.json
MTF_PUSH_POLL_SECONDS=300
MTF_PUSH_TIMEZONE=America/Chicago
```

Generate VAPID keys with:

```bash
npx web-push generate-vapid-keys
```

## Run Locally

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

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). Vite proxies `/api` requests to FastAPI.

## Railway Personal Deploy

1. Create a Railway project from this GitHub repo.
2. Add a persistent volume mounted at `/data`.
3. Set Railway variables:

```text
WEBULL_APP_KEY=...
WEBULL_APP_SECRET=...
WEBULL_ENV=prod
WEBULL_REGION=us
WEBULL_TOKEN_DIR=/data/.webull-token
WATCHLIST_FILE=/data/watchlists.json
WEBULL_GUARD_ENABLED=true
WEBULL_GUARD_FILE=/data/webull-guard.json
APP_USERNAME=sushanth
APP_PASSWORD=<strong private password>
```

For Web Push on Railway, also set:

```text
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:you@example.com
PUSH_SUBSCRIPTION_FILE=/data/push-subscriptions.json
MTF_PUSH_POLL_SECONDS=60
MTF_PUSH_TIMEZONE=America/Chicago
```

After deploy, open the app on the device, sign in, and tap **Enable Notifications** once. Keep the same VAPID keys and keep `PUSH_SUBSCRIPTION_FILE` on the `/data` volume so subscriptions survive deploys.

Railway uses `nixpacks.toml` to install Python dependencies, install/build the React frontend into `app/static`, and run:

```bash
uvicorn app.main:app --host 0.0.0.0 --port $PORT
```

The `/health` endpoint is public for Railway health checks. All other routes are protected when `APP_PASSWORD` is set.

## Useful Commands

```bash
npm --prefix frontend run build
.venv/bin/pytest tests/test_market_data.py tests/test_notifications.py -q
.venv/bin/uvicorn app.main:app --reload --port 8000
```

## API Surface

- `GET /health` - Public health check for Railway and local uptime checks.
- `GET /api/status` - Returns Webull configuration, environment, region, endpoint, and data-mode status.
- `GET /api/accounts` - Fetches the Webull account list used by the account selector.
- `GET /api/account/{account_id}/balance` - Fetches balance data for one Webull account.
- `GET /api/account/{account_id}/positions` - Fetches current positions for one Webull account.
- `GET /api/account/{account_id}/orders` - Fetches recent broker order history for one account.
- `GET /api/account/{account_id}/auto-trades` - Fetches today's auto-trade/open-order view used by the Trades tab.
- `GET /api/snapshot` - Returns a combined account snapshot; accepts an optional `account_id`.
- `GET /api/webull/quote` - Fetches a single live quote for a symbol.
- `GET /api/webull/live-prices` - Fetches watchlist quotes, 10m/hourly/daily EMAs, cloud states, and setup alert matches.
- `GET /api/webull/watchlists` - Loads persisted watchlists from the configured watchlist file.
- `POST /api/webull/watchlists` - Saves/replaces persisted watchlists.
- `GET /api/notifications/config` - Returns Web Push capability/configuration for the browser.
- `POST /api/notifications/subscribe` - Saves a browser push subscription for closed-app notifications.
- `POST /api/notifications/unsubscribe` - Removes a browser push subscription.
- `POST /api/notifications/test` - Sends a test Web Push notification when VAPID keys are configured.
- `GET /api/tradingview/analyze` - Runs TradingView analysis for a symbol, exchange, and timeframe.
- `GET /api/strategy/dry-run` - Runs the legacy dry-run strategy endpoint for selected symbols.
- `POST /api/trade/buy` - Places a guarded one-share buy order for an approved watchlist symbol.
- `POST /api/trade/auto-long` - Places a guarded long bracket order with entry, stop, target, and quantity.

## Project Structure

```text
app/
  main.py                 FastAPI app, auth middleware, static serving, push monitor
  market_data.py          Webull live price build, EMA clouds, setup alert rules
  notifications.py        Push subscription store and setup push monitor
  routers/                Accounts, Webull, notifications, trading, TradingView APIs
frontend/src/
  App.jsx                 Main app coordinator
  components/             Header, pages, tables, settings, watchlist controls
  hooks/                  App-specific React hooks
  lib/                    API client, market helpers, settings, watchlists, notifications
tests/
  test_market_data.py
  test_notifications.py
```

## Safety Notes

- Credentials are never sent to the browser.
- Use `APP_PASSWORD` before exposing the app publicly.
- Keep `WEBULL_GUARD_ENABLED=true` unless Webull support has reset a verification/rate-limit lock and you need one controlled retry.
- Trade endpoints are server-side, margin-account-only, and limited to symbols in approved watchlists.
- Review orders in Webull. This app is a personal trading tool, not a broker or risk manager.
