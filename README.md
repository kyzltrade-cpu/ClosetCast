# ClosetCast

One-loop demand testing for in-store retail capture. Scan a tag, save an item, get one text.

## Setup

1. `cp .env.example .env`
2. Fill in `.env` with your credentials (see below)
3. `npm install`
4. `npm start`
5. Open `http://localhost:3000`

## Environment variables

| Var | Where to get it |
|---|---|
| `TWILIO_ACCOUNT_SID` | Twilio Console → Account SID |
| `TWILIO_AUTH_TOKEN` | Twilio Console → Auth Token |
| `TWILIO_FROM_NUMBER` | Twilio Console → Phone Numbers (e.g. `+12125551234`) |
| `NVIDIA_API_KEY` | build.nvidia.com → API Keys |
| `NVIDIA_BASE_URL` | `https://integrate.api.nvidia.com/v1` |
| `NVIDIA_MODEL` | `meta/llama-3.1-8b-instruct` |
| `REMINDER_DELAY_HOURS` | `24` for production, `0.05` (~3 min) for testing |

## Quick test

Set `REMINDER_DELAY_HOURS=0.05` — the reminder will fire ~3 minutes after scanning.

## API

| Endpoint | Method | Description |
|---|---|---|
| `/products/:barcode` | GET | Look up product by barcode from products.json |
| `/scan` | POST | Capture a lead and send opt-in SMS |
| `/leads` | GET | List all captured leads |

## What's intentionally NOT built

- User accounts, login, or auth
- A browsable "closet" or saved-items list for the shopper
- Alerts on/off toggle or item removal
- Multi-turn SMS conversation
- Autonomous discounting or negotiation
- Cross-store inventory checking
- A real database — leads.json is correct for this stage

## Compliance notes

- **Double opt-in:** the first SMS requires a YES reply before any marketing content
- **STOP handling:** Twilio handles STOP/START at the account level — no custom code needed
- **Quiet hours:** no sends between 9pm–8am ET (US Eastern assumed; flag this if per-lead timezone is needed later)
- **A2P 10DLC:** not needed for local testing, but start registration in the Twilio Console before any real pilot

## Deployment

This runs as a long-running Node process. Recommended platforms:
- **Railway** — `railway.app` (easiest)
- **Fly.io** — `fly.io`
- **Render** — `render.com`

Not suitable for Vercel (serverless functions with no persistent cron process).
