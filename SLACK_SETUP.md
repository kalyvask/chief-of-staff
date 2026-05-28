# Slack thread-native setup

@-mention the agent in Slack. It writes a Yellow queue item with the thread metadata, drafts a reply, and posts back in the same thread. Reply with `/approve q_...` or `/close q_...` to close the loop without leaving Slack.

## What ships

- `POST /api/slack/event` in `server.mjs`: receives Slack Events API payloads. Handles URL verification, app mentions, and thread replies that look like `/approve <queue-id>` or `/close <queue-id>`.
- `tools/slack-respond.mjs`: outbound helper. Uses `chat.postMessage` with a bot token (supports thread replies) or falls back to an incoming webhook (channel-only).
- Signature verification (HMAC-SHA256 with `SLACK_SIGNING_SECRET`) if the secret is set; soft mode for local dev if not.

## Setup

### 1. Create the Slack app

Go to `https://api.slack.com/apps` and create a new app. Bot Token Scopes you need under **OAuth & Permissions** (add then click **Install to workspace**):

- `app_mentions:read` — receive `@bot` mentions in channels
- `chat:write` — post messages
- `channels:history` — read messages in channels the bot is invited to (parses `/approve` and `/close` from threads)
- `im:history` — read DMs to the bot (so the server can reply in DMs)
- `im:write` — open DMs

After installing, the bot needs to be invited to the channels where you want to use it (DMs auto-work; for channels: `/invite @your-bot-name #your-channel`).

Copy three values into your `.env`:

```
SLACK_SIGNING_SECRET=xxx   # Basic Information -> App Credentials -> Signing Secret
SLACK_BOT_TOKEN=xoxb-...   # OAuth & Permissions -> Bot User OAuth Token
SLACK_WEBHOOK_URL=         # optional fallback: Incoming Webhooks -> create one for a single channel
```

### 1a. Enable DM messaging (App Home)

Slack disables sending messages to bots by default. To DM the agent:

1. Left nav: **Features → App Home**
2. Toggle **Messages Tab** to on
3. Check **Allow users to send Slash commands and messages from the messages tab**

If you skip this, Slack silently blocks every DM with "Sending messages to this app has been turned off" and the server never sees the event. There is no error in the server log because the request never leaves Slack.

### 2. Expose the endpoint

`server.mjs` runs on port 3030 locally. Slack needs a public HTTPS URL. Pick one:

```bash
# ngrok
ngrok http 3030
# Cloudflare Tunnel
cloudflared tunnel --url http://localhost:3030
```

The Request URL for Slack is `https://<your-tunnel>/api/slack/event`.

### 3. Wire Event Subscriptions

In the Slack app config, under **Event Subscriptions**:

- Enable events
- Request URL: `https://<your-tunnel>/api/slack/event`
- Slack will hit it once with a `url_verification` payload. The endpoint responds with the challenge automatically.
- Subscribe to bot events: `app_mention`, `message.channels` (and `message.im` if you want DMs).

Save. Reinstall the app to the workspace if Slack prompts.

### 4. Invite the bot to a channel and mention it

```
/invite @your-bot-name #your-channel
@your-bot-name what is on my plate this afternoon?
```

Two things happen, in this order:

1. The `/api/slack/event` endpoint fires a real-time LLM reply (Sonnet, ~3-5s) and posts back in-thread via `postSlack()`. This is the conversational layer — replies use a stripped voice-rules system prompt; for full agent work the reply will tell you to switch to the laptop.
2. A queue item is created with `source: slack`, `source_id: <channel>:<thread_ts>`, and the message text in `provenance`. The queue item is the durable work record so the next `/am-sweep` can revisit the thread if needed.

For plain DMs (not channel mentions), only step 1 fires; DMs are conversation, not work items. The bot's own reply re-triggers the event but is filtered via `!event.bot_id` so the loop closes cleanly.

### 5. Approve or close from Slack

In the same thread:

```
/approve q_2026-05-20_007
/close q_2026-05-20_007
```

The endpoint updates the queue item without you leaving Slack. Approval lets tier-2 and tier-3 actions run against it on the next agent pass.

## Outbound from the agent

The agent posts back into the same thread it was mentioned in:

```bash
node tools/slack-respond.mjs --channel C123ABC --thread 1700000000.000100 --text "drafted, see q_2026-05-20_007"
```

If a queue item carries `source_id: <channel>:<thread_ts>`, that string splits on the colon to recover both fields.

## What is in scope today, what is not

In scope:

- @-mention -> queue item (Yellow) + real-time in-thread reply
- DM to the bot -> real-time reply (no queue item; DMs are conversation)
- Thread reply `/approve` or `/close` -> queue transition
- Outbound thread reply via `chat.postMessage`
- Channel-wide announcements via incoming webhook fallback
- Push from `red-alert` hook: DMs new Yours/high queue items via `postSlack` (uses `SLACK_ALERT_CHANNEL` if set, else falls back to webhook)

Out of scope for v1:

- File uploads from Slack to the agent
- Slack-to-Slack DMs initiated by the agent on its own schedule
- Block Kit interactive buttons (the approval is plain text `/approve` for now)
- Richer reply context (the default `SLACK_REPLY_SYSTEM` is generic; extend it in `server.mjs` to include stakeholders + priorities if you want replies that reflect your actual day)

### Tunnel persistence

The quick tunnel (`cloudflared tunnel --url http://localhost:3030`) prints a fresh URL on every restart. Slack Event Subscriptions remembers the last URL you pasted, so a tunnel restart requires re-pasting in Slack and re-verifying. For permanent setup, create a named tunnel with your Cloudflare account: `cloudflared tunnel login`, `tunnel create chief-of-staff`, `tunnel route dns chief-of-staff <subdomain>`, then `tunnel run chief-of-staff`. Stable URL across reboots; paste in Slack once.

The server (`npm run ui`) and tunnel both have to stay running for inbound `@-mention` and DM events to reach the agent. For unattended operation, run them as detached PowerShell jobs or scheduled tasks at boot.

## Security

- Always set `SLACK_SIGNING_SECRET`. Without it the endpoint runs in soft mode and accepts any caller, which is a problem the moment you put a public tunnel in front of it.
- The endpoint only writes to the queue. It does not execute any side-effect action. The permit engine still gates anything downstream.
- The webhook fallback (`SLACK_WEBHOOK_URL`) is tied to a single channel; treat it as broadcast-only.
