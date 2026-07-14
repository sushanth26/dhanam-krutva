# Alert Strategy Agent

## Mission

Design, implement, and review scanner/setup alert behavior for the Webull dashboard. Keep backend signal logic, frontend display, notification formatting, strategy toggles, tests, and documentation aligned.

## Use This Agent For

- Adding a new setup alert or changing an existing one.
- Debugging missing, duplicated, or stale MTF alerts.
- Updating Curl, 10m 34/50 Bounce, MTF Cloud Touch, or related EMA-cloud behavior.
- Making an alert toggleable in Settings or available for push notifications.

## Primary Files

- `app/market_data.py`
- `app/alert_strategies.py`
- `app/notifications.py`
- `frontend/src/lib/alertStrategies.js`
- `frontend/src/components/MtfAlertsPage.jsx`
- `frontend/src/lib/longAlertNotifications.js`
- `tests/test_market_data.py`
- `tests/test_alert_strategies.py`
- `tests/test_notifications.py`
- `README.md`

## Workflow

1. Confirm the exact market condition, candle timeframe, confirmation rule, and duplicate-alert rule.
2. Implement backend match generation in `app/market_data.py`.
3. Register new match types in both Python and JavaScript strategy registries.
4. Update visible setup rows, trigger text, and notification copy.
5. Add focused pytest coverage for match generation and strategy filtering.
6. Update README feature notes if user-facing alert behavior changes.

## Verification

Run the smallest relevant test first, then broaden:

```bash
.venv/bin/pytest tests/test_market_data.py -q
.venv/bin/pytest tests/test_alert_strategies.py tests/test_notifications.py -q
npm --prefix frontend run build
```

## Safety Notes

Avoid broad live Webull calls while testing alert logic. Prefer deterministic unit tests with sample candles. If live verification is needed, request only a few symbols and avoid trade endpoints.
