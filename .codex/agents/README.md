# Project Agents

These agent briefs define focused roles for recurring work in this repository. Use them by copying the relevant brief into a new task or by asking Codex to "act as the Alert Strategy Agent", "Backend API Agent", or "Frontend UX Agent" for the change.

## Available Agents

- `alert-strategy-agent.md`: adds, changes, and reviews trading setup alert logic.
- `backend-api-agent.md`: owns FastAPI routes, settings, persistence, auth, and backend tests.
- `frontend-ux-agent.md`: owns React dashboard behavior, layout, state flow, and frontend build validation.

## Shared Rules

- Read `README.md`, `AGENTS.md`, and `CLAUDE.md` before broad changes.
- Do not edit generated files in `app/static/assets/`; rebuild from `frontend/`.
- Treat `app/routers/trade.py` and `app/webull_service.py` as high-risk.
- Keep `.env`, token caches, subscriptions, guard files, and local live-data state out of commits.
- Prefer focused tests and validation commands over broad unrelated refactors.
