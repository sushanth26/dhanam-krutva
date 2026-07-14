# Repository Guidelines

## Project Structure & Module Organization

This is a personal Webull dashboard with a FastAPI backend and Vite/React frontend. Backend code lives in `app/`: routers are in `app/routers/`, with shared logic in modules such as `webull_service.py`, `market_data.py`, `notifications.py`, and `watchlists.py`. Frontend source lives in `frontend/src/`, with components, hooks, and client helpers under matching subfolders. Tests are pytest files in `tests/`. Built frontend assets are served from `app/static/`; do not edit generated assets by hand.

## Build, Test, and Development Commands

- `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt -r requirements-dev.txt`: create the Python environment.
- `npm --prefix frontend install`: install frontend dependencies.
- `.venv/bin/uvicorn app.main:app --reload --port 8000`: run the FastAPI backend locally.
- `npm --prefix frontend run dev`: run Vite at `http://127.0.0.1:5173`.
- `npm --prefix frontend run build` or `npm run build`: build the React app into `app/static`.
- `.venv/bin/pytest -q`: run the backend test suite.
- `python -m compileall app`: quick Python syntax check.

## Coding Style & Naming Conventions

Use 4-space indentation for Python and existing FastAPI patterns for routers, dependencies, and settings. Keep Python modules snake_case, test files named `test_*.py`, and functions descriptive. React components use PascalCase, hooks use `useSomething`, and utilities follow existing camelCase names. There is no configured formatter or linter, so match surrounding style.

## Testing Guidelines

Add or update pytest coverage for backend behavior, especially market data, watchlists, auth, notifications, and trade guards. Prefer focused tests near the affected module, e.g. `tests/test_market_data.py::test_name`. Frontend test files exist in `frontend/src/lib/*.test.js`, but no frontend test script is configured; validate with `npm --prefix frontend run build`.

## Commit & Pull Request Guidelines

Recent history uses short imperative commit messages such as `Fix scanner alerts and startup refresh`. Keep commits focused and describe user-visible behavior. Pull requests should summarize the change, list verification commands, link relevant issues, and include screenshots for UI changes.

## Security & Configuration Tips

Treat `app/routers/trade.py` and `app/webull_service.py` as high-risk because production settings can place real orders. Use `WEBULL_ENV=uat` for trade-related testing when possible. Keep `.env`, Webull token caches, push subscriptions, guard files, and live-data unlock state out of commits.

## Project Agent Briefs

Reusable focused-agent briefs live in `.codex/agents/`. Use `alert-strategy-agent.md` for setup logic, `backend-api-agent.md` for FastAPI work, and `frontend-ux-agent.md` for dashboard UI changes.
