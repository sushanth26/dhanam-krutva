# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A personal, single-user Webull trading dashboard. FastAPI backend talks to the Webull OpenAPI SDK (accounts, balances, positions, historical bars) and a React/Vite frontend renders live prices, watchlists, and long-only MTF/EMA-cloud setup alerts, with optional web-push notifications to a phone. The trade router does place real orders against the configured Webull environment (`WEBULL_ENV=uat` or `prod`), so treat `app/routers/trade.py` and `app/webull_service.py` changes as high-stakes. See `README.md`'s "Features" section for the current user-facing feature list — it's kept accurate and is worth re-reading each session since this app iterates fast.

## Commands

Setup:
```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt -r requirements-dev.txt
npm --prefix frontend install
cp .env.example .env   # then fill in Webull credentials
```

Run for local dev (two terminals, hot reload both sides):
```bash
.venv/bin/uvicorn app.main:app --reload --port 8000
npm --prefix frontend run dev   # http://127.0.0.1:5173, proxies /api to FastAPI
```

Run production-style (single origin, built frontend served by FastAPI):
```bash
npm --prefix frontend run build
.venv/bin/uvicorn app.main:app --reload --port 8000   # http://127.0.0.1:8000
```

Tests:
```bash
.venv/bin/pytest -q                          # full suite
.venv/bin/pytest tests/test_market_data.py -q             # one file
.venv/bin/pytest tests/test_market_data.py::test_name -q  # one test
```

Python syntax/compile check and frontend build are what CI (`.github/workflows/pr-checks.yml`) actually runs — there is no configured linter/formatter:
```bash
python -m compileall app
npm --prefix frontend run build
npm --prefix frontend audit --omit=dev
```

## Architecture

**Backend (`app/`)**
- `main.py` — FastAPI app assembly. Mounts all routers, serves the built frontend from `app/static` with SPA fallback (any unmatched path returns `index.html`), and applies a global HTTP Basic Auth middleware (`require_app_auth`) gating every route except `/health`. Auth is only enforced when `APP_PASSWORD` is set (`Settings.auth_enabled`). Starts `MtfPushMonitor` as a background task on startup and stops it on shutdown.
- `config.py` — single `Settings` dataclass loaded from env via `get_settings()` (not cached — reads env fresh each call). Holds Webull credentials/env, auth creds, VAPID push keys, and file paths for local JSON state (watchlists, push subscriptions, webull guard, alert strategy toggles). File paths auto-switch to `/data/...` when running on Railway (detected via `RAILWAY_ENVIRONMENT`/`RAILWAY_PROJECT_ID`), otherwise dotfiles in the repo root.
- `webull_service.py` — thin wrapper around the Webull OpenAPI SDK client: auth/token lifecycle, account list/balance/positions, historical bar fetches. Most other backend modules depend on `service()` from `dependencies.py` to get a configured instance rather than constructing their own.
- `strategy.py` — shared EMA/candle-normalization primitives (`normalize_bars`, `snapshot_price`, `find_snapshot_list`) plus `evaluate_symbol`/`run_dry_run` used by the (currently unused-in-prod) `/api/strategy/dry-run` route. Several other functions in this area of the codebase (e.g. `market_data.py`'s `mtf_matches`, `ema_touch_matches`) are dead code from earlier iterations — not wired into `mtf_signal_matches`. Verify with a `grep` for the call site before assuming a function is live.
- `market_data.py` — the core alert engine. Defines the hardcoded `LIVE_WATCHLIST` (~23 tickers) and `SYMBOL_SECTORS`, pulls 10m/1H/1D bars per symbol (batched, `WEBULL_BATCH_BAR_LIMIT`), computes EMA clouds, and produces `mtf_matches` per quote via `mtf_signal_matches()`. Current live match types: `long_mtf_5_12_touch` ("Curl" — MTF cloud touch then reclaim above 10m 5/12), `10m_34_50_bounce` (confirmed 10m close back above the 34/50 cloud), and `mtf_cloud_price_touch` (live price sitting inside Hourly 34/50 / Daily 20/21 / Daily 50/55, fires once per 10m candle via `candle_time`). New alert logic belongs here.
- `alert_strategies.py` — `ALERT_STRATEGIES` (match-type → strategy-key registry) and `AlertStrategySettingsStore`, a JSON-file-backed on/off toggle per strategy. `filter_enabled_matches`/`apply_enabled_strategies` (in `notifications.py`) gate both the push-notification pipeline and (via the mirrored JS registry) the frontend Setups table. **When adding a new alert/match type, register it in both this file's `ALERT_STRATEGIES` and the matching entry in `frontend/src/lib/alertStrategies.js`** — the Settings tab toggle is driven by that registry, not auto-discovered from match data.
- `notifications.py` — `PushSubscriptionStore` (persists phone push subscriptions to JSON) and `MtfPushMonitor` (background polling loop that re-evaluates the MTF table on an interval, filters matches through `AlertStrategySettingsStore`, and sends a web-push notification via VAPID when the resulting signature changes; poll interval and timezone are configurable via `MTF_PUSH_POLL_SECONDS`/`MTF_PUSH_TIMEZONE`). `mtf_match_signature()` keys on `candle_time` among other fields — that's what makes an alert fire once per candle rather than once per poll.
- `watchlists.py` — `WatchlistStore`, simple JSON-file-backed CRUD for user-defined symbol watchlists (separate from the hardcoded `LIVE_WATCHLIST`).
- `auth.py` — HTTP Basic Auth check (`is_authorized`) used by the `main.py` middleware.
- `dependencies.py` — FastAPI dependency wiring, primarily `service()` returning the shared `WebullService`.
- `tradingview_mcp.py` — integration for pulling TradingView analysis via MCP, exposed through `routers/tradingview.py`.
- `routers/` — one module per API surface, all mounted in `main.py`: `accounts` (`/api/status`, `/api/accounts`), `webull` (`/api/webull/...`, live prices from `market_data`), `strategy` (`/api/strategy/dry-run`), `notifications` (`/api/notifications/...` — push subscribe/unsubscribe, `GET`/`POST /api/notifications/strategies` for the alert-strategy toggles), `trade` (`/api/trade/...`, places real buy/sell orders — validates against `WatchlistStore` and `Settings`), `tradingview` (`/api/tradingview/analyze`).

**Frontend (`frontend/src`)**
- `App.jsx` — single large root component owning most state and API orchestration (watchlists, quotes polling, auto-trade/risk settings, notifications).
- `components/` — `HomePage.jsx` (Scanner tab), `MtfAlertsPage.jsx` (Setups/MTFs tab — `longAlertRows()` here is the single filter that decides which `mtf_matches` become visible rows, gated by `alertStrategyEnabled`), `SettingsMenu.jsx` (`ActiveStrategiesPanel` renders one toggle per entry in `ALERT_STRATEGIES` — this is the "auto-populates" mechanism, so a new strategy just needs a registry entry, not new UI code), `WatchlistTabs.jsx`, `PriceTables.jsx`, `Header.jsx`, `Tags.jsx`, `SummaryTile.jsx`.
- `lib/alertStrategies.js` — mirrors `app/alert_strategies.py`'s registry client-side (`ALERT_STRATEGIES`, `alertStrategyEnabled`) plus `fetchAlertStrategies`/`saveAlertStrategiesRemote` to sync toggle state with the backend store (so it also gates server-side push notifications, not just the UI).
- `lib/settings.js` — localStorage persistence for risk settings and auto-trade/strategy toggles (`AUTO_TRADE_KEY`); hydrated from the backend registry on mount, then kept in sync via `App.jsx`'s `updateAutoTradeSettings`.
- `lib/longAlertNotifications.js` — formats in-app/device notification title+body per match `type`; needs a branch here (and in `MtfAlertsPage.jsx`'s `SetupTriggerList`) whenever a new match `type` is added.
- `lib/market.js`, `lib/notifications.js` — API client + formatting helpers; `lib/notifications.js` also manages the browser's service worker push subscription flow (`public/sw.js`).
- `hooks/` — `useShellData` (accounts/status), `useAppNotifications` (in-app notification drawer state), `useLoadingState`, `useLatestRef`.
- Vite dev server proxies `/api/*` to the FastAPI backend on port 8000 (see `vite.config.js`); production build output goes to `app/static` and is served directly by FastAPI (see `AppStaticFiles` in `main.py`, which sets long-cache headers for hashed `assets/*` and no-store for `sw.js`/`manifest.webmanifest`). **Python code changes require restarting `uvicorn` unless it was started with `--reload`** — static frontend rebuilds don't need a restart, but backend edits do.

**Auth model**: everything except `/health` requires HTTP Basic Auth in any environment where `APP_PASSWORD` is set (this includes Railway deploys). Credentials never reach the browser — Webull calls are proxied server-side. Locally, if `.env` has no `APP_PASSWORD`, auth is silently disabled — don't mistake that for a bug.

**Local JSON state files** (gitignored except `.watchlists.json`, which is tracked as seed data; live at repo root locally / `/data` on Railway): `.watchlists.json`, `.webull-guard.json`, `.web-push-subscriptions.json`, `.alert-strategies.json`, plus the Webull SDK token cache dir (`.webull-token/`). Tests and local dev read/write these directly unless overridden via env vars in `config.py`.

## Notes for making changes

- New alert/match types go in `market_data.py`'s `mtf_signal_matches()` (evaluation logic) and/or `strategy.py` (shared primitives). To make one toggleable in Settings and filterable from push notifications, also add an entry to `ALERT_STRATEGIES` in both `app/alert_strategies.py` and `frontend/src/lib/alertStrategies.js`, and a display branch in `MtfAlertsPage.jsx`'s `SetupTriggerList` + `lib/longAlertNotifications.js`. Update `README.md`'s Features section to match.
- `LIVE_WATCHLIST` in `market_data.py` is currently hardcoded — it is distinct from user-managed watchlists in `watchlists.py`/`.watchlists.json`.
- `app/routers/trade.py` executes real trades when `WEBULL_ENV=prod`; be deliberate with changes there and prefer testing against `WEBULL_ENV=uat` first. Any change touching `market_data.py`/`webull_service.py` that gets verified live should use small, deliberate read-only requests (`/api/status`, a 2-3 symbol `/api/webull/live-prices`) — Webull enforces a verification/rate-limit lockout (see `webull_guard_enabled` in `config.py`) that a broad request pattern can trip.
- There is a stray duplicate `app/strategy 2.py` in the working tree (a filesystem sync-conflict artifact, not real code) — ignore it, don't edit it.
