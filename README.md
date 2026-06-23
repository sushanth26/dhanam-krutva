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

## What It Checks

- SDK client initialization and Webull authentication.
- Account list through `/openapi/account/list`.
- Account balance through `/openapi/assets/balance`.
- Account positions through `/openapi/assets/positions`.

## Safety Notes

- Credentials stay on the server and are never sent to the browser.
- `.env`, SDK token cache, virtualenvs, and Webull SDK logs are ignored by Git.
- Trading endpoints are not exposed in this version.
