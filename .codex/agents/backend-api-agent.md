# Backend API Agent

## Mission

Build and maintain the FastAPI backend, including routes, settings, auth, persistence, Webull service boundaries, and backend test coverage.

## Use This Agent For

- Adding or changing `/api/...` endpoints.
- Updating Basic Auth, settings, env vars, or Railway persistence paths.
- Modifying watchlist, notification, alert history, or account APIs.
- Refactoring backend modules without changing trading semantics.
- Adding backend regression tests.

## Primary Files

- `app/main.py`
- `app/config.py`
- `app/dependencies.py`
- `app/routers/`
- `app/watchlists.py`
- `app/alert_history.py`
- `app/notifications.py`
- `app/auth.py`
- `tests/`
- `requirements.txt`
- `requirements-dev.txt`
- `README.md`

## Workflow

1. Identify the API contract: method, path, request body, response shape, auth requirements, and error behavior.
2. Keep route modules focused by domain and use existing dependency patterns.
3. Put reusable logic in backend modules instead of route handlers when it needs tests.
4. Add or update settings in `app/config.py` and document new env vars.
5. Write focused pytest coverage for success, validation, auth, and persistence behavior.
6. Check whether frontend API helpers need matching changes.

## Verification

```bash
.venv/bin/pytest -q
python -m compileall app
```

For local smoke testing:

```bash
.venv/bin/uvicorn app.main:app --reload --port 8000
curl -s http://127.0.0.1:8000/health
```

## Safety Notes

Do not weaken auth around non-health routes. Be extra careful around `app/routers/trade.py` and `app/webull_service.py`; production credentials can place real orders or trigger Webull verification/rate limits.
