# Email Notify Worker (Cloudflare + Brevo)

This Worker receives webhook POST requests, validates a shared secret, reads `emails` from payload JSON, and sends notification emails using Brevo.

## 1) Install

```bash
npm install
```

## 2) Configure local env

Copy and edit:

```bash
cp .dev.vars.example .dev.vars
```

Set values in `.dev.vars`:

- `WEBHOOK_SECRET` = your incoming webhook secret
- `BREVO_API_KEY` = your Brevo API key
- `BREVO_SENDER_EMAIL` = sender identity verified in Brevo
- `BREVO_SENDER_NAME` = optional sender display name

## 3) Run locally

```bash
npm run dev
```

## 4) Test request

```bash
curl --request POST "http://127.0.0.1:8787" \
  --header "content-type: application/json" \
  --header "x-webhook-source: kuppihub-db-trigger" \
  --header "x-webhook-secret: hi" \
  --data '{
    "title": "Fluid Dynamics P1",
    "emails": [
      "nipunsgeeth@gmail.com",
      "nsangeeth920@gmail.com",
      "sangeethnipun385@gmail.com"
    ],
    "is-kuppi": true,
    "is_kuppi": true,
    "video_id": 159,
    "description": "Kuppi 1, Batch 23",
    "module_code": "CE1023",
    "module_name": "Fluid Mechanics",
    "language-code": "si",
    "language_code": "si"
  }'
```

## 5) Deploy

Set production secrets:

```bash
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put BREVO_API_KEY
npx wrangler secret put BREVO_SENDER_EMAIL
npx wrangler secret put BREVO_SENDER_NAME
```

Deploy:

```bash
npm run deploy
```

## Notes

- The Worker requires valid `x-webhook-secret`.
- If `WEBHOOK_SOURCE` is set in `wrangler.toml`, the header `x-webhook-source` must match it.
- Invalid or empty recipient lists are rejected.
