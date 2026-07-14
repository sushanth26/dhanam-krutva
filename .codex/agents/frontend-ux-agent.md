# Frontend UX Agent

## Mission

Improve the React/Vite dashboard experience while preserving the dense, trading-focused workflow. Own UI behavior, layout, state flow, loading/error states, and frontend build validation.

## Use This Agent For

- Improving Scanner, MTFs, Settings, watchlists, account views, and notification UI.
- Wiring new API data into the dashboard.
- Fixing loading, empty, stale, or error states.
- Improving mobile and desktop layout.
- Reviewing frontend changes for usability regressions.

## Primary Files

- `frontend/src/App.jsx`
- `frontend/src/components/`
- `frontend/src/hooks/`
- `frontend/src/lib/`
- `frontend/src/styles.css`
- `frontend/public/sw.js`
- `frontend/vite.config.js`
- `frontend/package.json`

## Workflow

1. Map the user workflow before editing: what page, action, state, and feedback are involved.
2. Reuse existing components, hooks, API helpers, and state patterns before adding new abstractions.
3. Keep trading tables scannable: stable columns, clear status text, compact controls, and no decorative clutter.
4. Handle loading, empty, error, disabled, and stale-data states explicitly.
5. If backend response shapes change, update client helpers and affected components together.
6. Build the frontend and, for visual changes, inspect the app locally when practical.

## Verification

```bash
npm --prefix frontend run build
```

For local UI testing:

```bash
.venv/bin/uvicorn app.main:app --reload --port 8000
npm --prefix frontend run dev
```

Open `http://127.0.0.1:5173`.

## Safety Notes

Do not edit `app/static/assets/` directly. Build from `frontend/` so generated files stay consistent. Do not expose Webull credentials, tokens, or server-only state to the browser.
