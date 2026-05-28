# MCP Setup: Gmail and Google Calendar

Last updated: 2026-05-21

Two paths. Pick one.

## Path A: Composio-managed (fastest, ~3 minutes)

Composio hosts the OAuth flow and the MCP server. You sign up, get an API key, and one command authorizes Gmail + Calendar through their managed OAuth. No Google Cloud project, no OAuth keys file.

```bash
# 1. Get a Composio API key from https://app.composio.dev/settings/api-keys
# 2. Add it to .env:
#      COMPOSIO_API_KEY=ak_...
# 3. Run the connect flow:
npm run composio:connect
```

The script opens your browser at each step: Gmail OAuth, then Calendar OAuth, then writes `.mcp.composio.json` containing the per-user MCP URL. Point Claude Code at that file or merge it into your project `.mcp.json`.

Verify:

```bash
npm run check:composio          # confirms both connections are active
npm run composio:status         # detail view: user id, connections, MCP servers
```

Tradeoff: your Gmail and Calendar data flows through Composio's hosted MCP rather than a local stdio server. Read their terms before opting in. For the manual path (everything local), see Path B below.

## Path B: Your own Google Cloud project + local stdio servers (15-20 minutes)

Path B is what `.mcp.json` ships configured for: two stdio MCP servers (`@gongrzhe/server-gmail-autoauth-mcp` and `@cocal/google-calendar-mcp`) launched by `npx`. Both need a `gcp-oauth.keys.json` file containing OAuth client credentials from your own Google Cloud Console project. Anthropic does not host these credentials. You create them yourself, once. The credentials file is per-machine, and the read-only vs read-write distinction is enforced by the OAuth scopes you grant during the consent screen.

## One-time setup for Path B (15-20 minutes)

### 1. Create a Google Cloud project

Go to https://console.cloud.google.com/ and create a new project (name it whatever you want, "claude-chief-of-staff" is fine).

### 2. Enable the APIs

In the project, go to **APIs and Services > Library** and enable:
- **Gmail API**
- **Google Calendar API**

### 3. Configure the OAuth consent screen

Go to **APIs and Services > OAuth consent screen**. Choose **External**, fill in the basics (app name, your email). When you reach the **Scopes** step, add **read-only** scopes only, for now:

For Gmail:
- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/gmail.metadata`

For Calendar:
- `https://www.googleapis.com/auth/calendar.readonly`
- `https://www.googleapis.com/auth/calendar.events.readonly`

Add yourself (`alexandroskalivas1@gmail.com`) as a test user. The app does not need to be published for personal use.

### 4. Create OAuth credentials

Go to **APIs and Services > Credentials > Create Credentials > OAuth client ID**.
- Application type: **Desktop app**
- Name: anything

Download the resulting JSON file. Rename it to **`gcp-oauth.keys.json`**.

### 5. Place the file where the MCP servers expect it

The Gmail server looks for it in `C:\Users\alexa\.gmail-mcp\gcp-oauth.keys.json`.
The Calendar server looks for it next to the package, or wherever `GOOGLE_OAUTH_CREDENTIALS` points.

The cleanest setup is one shared file plus an env var. From PowerShell:

```powershell
# Create the directory and copy the credentials file
mkdir "$env:USERPROFILE\.google-mcp" -Force
copy "$env:USERPROFILE\Downloads\gcp-oauth.keys.json" "$env:USERPROFILE\.google-mcp\gcp-oauth.keys.json"

# Also place a copy where the Gmail server expects it
mkdir "$env:USERPROFILE\.gmail-mcp" -Force
copy "$env:USERPROFILE\.google-mcp\gcp-oauth.keys.json" "$env:USERPROFILE\.gmail-mcp\gcp-oauth.keys.json"
```

Then update `.mcp.json` to point the calendar server at the credentials via env var:

```json
"gcal": {
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@cocal/google-calendar-mcp"],
  "env": {
    "GOOGLE_OAUTH_CREDENTIALS": "C:\\Users\\alexa\\.google-mcp\\gcp-oauth.keys.json"
  }
}
```

### 6. Authenticate each server

The first time you run Claude Code in this project after the OAuth file is in place, both servers will trigger an OAuth consent flow in your browser. Approve the read-only scopes you set up earlier.

### 7. Verify

```bash
cd "C:/Users/alexa/OneDrive/Documents/GSB/claude/chief-of-staff"
claude mcp list
```

Both `gmail` and `gcal` should now show as connected.

## Granola (optional, powers /debrief)

Granola is an optional integration. It powers the `/debrief` command, which pulls a meeting transcript and dispatches the `meeting-coach` subagent for a tactical critique tied to the relationship history. Without Granola, `/debrief` falls back to a calendar-only mode (flagged in the first line of the output) or skips.

### Why user-scope, not project-scope

This repo deliberately does not put Granola in `.mcp.json`. The author's setup keeps Granola at Claude Code's user (workspace) scope. Two reasons:

1. **Credentials stay out of the public repo.** User-scope config lives in `~/.claude.json` and never gets committed.
2. **One install, every project.** Granola is useful in any Claude Code session, not only this one. User-scope means it loads everywhere.

When set up this way, Granola shows up as `mcp__<uuid>__*` tools in every Claude Code session, including the chief-of-staff plugin and the standalone CLI launched from this repo. No project-level configuration is needed.

### How to install at user scope

Granola ships its own MCP server. The exact install command depends on how Granola distributes it at the time you read this (desktop app, separate CLI, or npm package). Two routes:

**Easiest:** in Claude Code, run `/mcp` and follow the in-app flow to add and authenticate Granola. Claude Code writes the entry to `~/.claude.json` for you.

**Manual:** edit `~/.claude.json` and add an `mcpServers` entry for Granola per Granola's official MCP setup docs. The standard stdio shape:

```json
"granola": {
  "type": "stdio",
  "command": "<granola mcp binary or npx package>",
  "args": [],
  "env": {
    "GRANOLA_API_KEY": "<your key>"
  }
}
```

Fill in `command`, `args`, and the env block from Granola's docs. The shape above is the generic stdio MCP pattern; the specifics are Granola's. Do not paste your real API key into this repo's `.mcp.json` or any tracked file. Keep it in `~/.claude.json` or in your shell environment.

### Verify

In a fresh Claude Code session in this repo:

```bash
claude mcp list
```

Granola should appear. Then in Claude Code, run `/debrief` against any recent meeting; the first call confirms the connection is live and the coach has access to the transcript.

### Without Granola

`/debrief` detects the missing MCP and either falls back to a calendar-only debrief (flagged) or skips. The rest of chief-of-staff (queue, permit, conformance, graph, the other slash commands) works without Granola.

## Adding write scopes later

When you decide you trust the agent to draft and send on your behalf, return to the OAuth consent screen and add the relevant write scopes (`gmail.send`, `calendar.events`). The hard rule in `CLAUDE.md` (never send externally without explicit approval on a specific draft) still applies even after write scopes are granted.

## Package references

- Gmail server: [`@gongrzhe/server-gmail-autoauth-mcp`](https://www.npmjs.com/package/@gongrzhe/server-gmail-autoauth-mcp)
- Calendar server: [`@cocal/google-calendar-mcp`](https://www.npmjs.com/package/@cocal/google-calendar-mcp)
- Both are community-maintained. Reasonable maintenance cadence and active issue trackers as of April 2026.
