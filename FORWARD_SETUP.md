# Forwarding-address setup

Send anything to a dedicated email address. The body becomes a Yellow queue item the agent picks up next morning. This is the Town pattern: forward "deal with this" emails from any device without building a mobile app.

## How it works

```
You forward an email to cos@<your-domain>
  -> Cloudflare Email Routing receives it
  -> A Cloudflare Worker (or Gmail filter + script) POSTs JSON to /api/forward
  -> server.mjs writes a queue item with provenance pointing back to the original
  -> /am-sweep picks it up tomorrow morning
```

The endpoint is `POST /api/forward`. Auth is a shared secret in the `X-Forward-Secret` header that must match `FORWARD_SECRET` in `.env`.

## Subject conventions

The endpoint parses three things out of the subject line:

- `[project-slug]` anywhere in the subject sets the queue item's project. Example: `[anthropic-pm-interview] timing question` routes the item into the `anthropic-pm-interview` project.
- `!high` or `!urgent` sets priority to high.
- `!low` sets priority to low.
- Default priority is med, default bucket is Prep.

All three are stripped from the visible summary before the item is saved.

## Setup options

### Option A: Cloudflare Email Routing + Worker (recommended)

1. Add your domain to Cloudflare and turn on Email Routing.
2. Create an email address (`cos@yourdomain.com`) that routes to a Worker.
3. Deploy a Worker that does the JSON POST. Minimal Worker:

```javascript
export default {
  async email(message, env) {
    const body = await new Response(message.raw).text();
    const subject = message.headers.get("subject") ?? "";
    const from = message.headers.get("from") ?? "";
    const messageId = message.headers.get("message-id") ?? "";

    await fetch(env.COS_FORWARD_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forward-Secret": env.FORWARD_SECRET,
      },
      body: JSON.stringify({ from, subject, body, message_id: messageId }),
    });
  },
};
```

Set `COS_FORWARD_URL` to a publicly reachable URL of your `server.mjs` (e.g. via ngrok or a small VM) and `FORWARD_SECRET` to the same value as in your `.env`.

### Option B: Gmail filter + Apps Script

If you do not want a domain, create a Gmail filter that forwards matching mail to a Google Apps Script trigger, and have the script POST to `/api/forward` with the same payload. Slower setup, no domain required.

### Option C: Manual one-shot

For ad-hoc captures from the command line:

```bash
curl -X POST http://localhost:3030/api/forward \
  -H "Content-Type: application/json" \
  -H "X-Forward-Secret: $FORWARD_SECRET" \
  -d '{
    "from": "Daniel <daniel@example>",
    "subject": "[anthropic-pm-interview] !high re: timing",
    "body": "Tuesday 3pm. Want to confirm?",
    "message_id": "<test-001@local>"
  }'
```

## Security

`server.mjs` is intended for local use. If you expose it via a tunnel or VM:

- Always set `FORWARD_SECRET` and require it on the endpoint.
- Run behind a TLS terminator (Cloudflare Tunnel, ngrok https, Caddy).
- The endpoint only creates a queue item; it does not execute any side-effect action. The permit engine still gates anything downstream.

## What gets created

A queue item with:

- `source: "forward"`, `source_id: <message-id>`
- `sender`: original from
- `bucket: "Prep"`, `priority`: parsed (high / med / low)
- `project`: parsed (if `[slug]` was in the subject)
- `summary`: cleaned subject (with tags stripped)
- `proposed_action`: a preview of the body
- `provenance`: `[{type: "gmail.forward", ref: <message-id>, ...}, {type: "sender", ref: <from>}]`

The next `/am-sweep` will see it alongside the rest of the morning's items.
