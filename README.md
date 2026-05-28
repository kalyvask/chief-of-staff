# chief-of-staff

A personal Claude Code agent that turns Gmail, Google Calendar, and a small file-based context library into a daily plan. Classifies open work into four buckets (Dispatch, Prep, Yours, Skip) and dispatches specialist subagents in parallel after approval. Drafts only; the human sends.

Primary interface is Slack: @-mention the bot from any device for ad-hoc requests, `/approve` or `/close` queue items in-thread, and the agent DMs you when a Red item lands. Desktop power use happens in Claude Code in this directory. See [SLACK_SETUP.md](SLACK_SETUP.md) for the two-tier setup path (outbound webhook in 3 minutes, full bidirectional in ~20).

The repo is structured as a template. Clone it, edit the context files and `CLAUDE.md` with your own identity, and the system is yours.

## Triage taxonomy

Every potential action is classified into one of four buckets. The full taxonomy lives in `CLAUDE.md`.

- **Dispatch (Green):** routine, low-stakes, fully handleable.
- **Prep (Yellow):** subagent gets it 80% ready; the human makes the call.
- **Yours (Red):** surface only, do not act.
- **Skip (Gray):** defer with a reason.

The default bias is to involve the human on anything ambiguous: default Yellow over Green when uncertain; default Red over Yellow on anything that touches a person or a commitment.

## Daily and weekly pattern

1. Overnight (scheduled): `/email-triage` at 6:00 AM, `/calendar-prep` at 6:15 AM. Both write to `logs/`. Read-only.
2. Morning: `/am-sweep`. Reads the open work queue first, then overnight files and live state, classifies new signals into the four buckets, writes them to the queue, dispatches subagents after approval.
3. Thirty to sixty minutes before any non-trivial meeting: `/prep <meeting>` (skipped if `/am-sweep` already produced the prep).
4. After the meeting or decision: `/commit [slug:] <decision>`, then invoke `relationship-curator` or update `memory/relationships.md` directly.
5. Sunday or Monday morning: `/cal-shape` to look at the next five business days and propose decline / shift / batch moves on the calendar.
6. End of week: `/retro`.

## What it actually produces

Redacted real output from 2026-05-21: [`docs/sample-am-sweep.md`](docs/sample-am-sweep.md). Includes a working overnight `/calendar-prep` brief (meeting-by-meeting "want / they want / risk" with conflict resolution and a drive-time proposal) and an honest `/email-triage` failure-mode log from the same morning.

## Status

Four layers of verification, each runnable independently.

### Deterministic substrate, `npm test`

65 fixtures over conformance rules, permission engine, queue lifecycle, graph ingestion, retrieval, entity extraction, and contradiction detection. Wired to GitHub Actions on push and pull request. Latest local run (2026-05-24):

```
ok    conform/clean email passes
ok    conform/polluted email fails
ok    conform/em dash detected
ok    conform/missing sources footer flagged
...
ok    permit/T1 email.archive denied at T0
ok    permit/approval-required denies T2 without itemId
...
ok    queue/add returns id
ok    queue/undo restores bucket
ok    queue/closed item not in loadOpen
...
ok    graph/all edges have type + from

39/39 passed
```

### Agent classification, `npm run eval:agent`

15 hand-built fixtures over the triage taxonomy at [`evals/fixtures/classification.jsonl`](evals/fixtures/classification.jsonl). Each fixture is a realistic queue item with an expected bucket (Dispatch / Prep / Yours / Skip). The runner sends each item to Claude with a deterministic classification prompt and compares the returned bucket against the label. Pass threshold defaults to 80% (configurable with `--threshold`).

`--k N` runs each fixture N times and reports per-fixture pass rate plus across-fixture variance, so you can tell "flaky on a specific case" from "broken." `--fixtures <path>` lets the same runner grade any classification-shape fixture file (used by the adversarial suite below).

Requires `ANTHROPIC_API_KEY`. Skipped gracefully when no key is set, so CI without the secret does not break. Suite is intentionally outside the deterministic `npm test` gate since LLM outputs have variance.

### Adversarial classification, `npm run eval:adversarial`

18 fixtures at [`evals/fixtures/adversarial.jsonl`](evals/fixtures/adversarial.jsonl) covering prompt injection, impersonation, PII smuggling, voice attacks, permission escalation, urgency pressure, context-extraction attempts, and calendar-based injection vectors. Every fixture's expected bucket is `Yours` (force human review). Threshold defaults to 95% because for safety-critical evals near-perfect is the bar.

### Email-drafter quality, `npm run eval:drafter`

10 fixtures at [`evals/fixtures/email-drafter.jsonl`](evals/fixtures/email-drafter.jsonl) covering clean confirms, missing-info placeholders, substantive replies, cold declines, mentor requests, voice-temptation traps, pricing-undecided cases, prior-decision references, and voice-under-pressure attacks. Each fixture has expected draft properties (conform-pass, sources footer present, must-cite facts, recipient pattern, must-not-contain hallucinations, must-have bracketed placeholders) graded deterministically against the drafter's output.

### Slack-reply quality, `npm run eval:slack-reply`

10 fixtures at [`evals/fixtures/slack-reply.jsonl`](evals/fixtures/slack-reply.jsonl) covering plate queries, urgent filtering, stakeholder-specific asks, drafting deferrals, decision lookups, project listings, vague clarification, hallucination traps, voice attacks, and out-of-scope action requests. Tests the `draftSlackReply` path in `server.mjs` against synthetic Alex-state contexts, using the same prompt + caching shape as production via the shared `SLACK_REPLY_SYSTEM_BASE` export.

### Substrate health, `npm run stats`

Computes aggregate state from the data files. No agent calls, no LLM. Pure file reads. Latest local run:

### Scheduled-job health, `npm run check:scheduler`

Walks the layers a scheduled overnight run depends on: repo path, batch files, `.mcp.json`, claude CLI on PATH, Task Scheduler registration (Windows) or crontab (Unix), today's overnight log status, and a fail-mode streak detector over the most recent five email-triage runs. Reports pass / warn / fail per layer and exits with a non-zero code on any fail. Surfaces the specific layer that broke instead of the whole pipeline going silent.

## Setup

Requirements: Node 18+, an Anthropic API key, and either a Composio API key (for hosted Gmail/Calendar MCP) or a Google Cloud project (for the self-hosted route). Optional: a Google Maps API key with the Directions API enabled for drive-time calculations.

Three install paths. **The Claude Code plugin is the recommended path** because it loads slash commands and subagents into every Claude Code session without a per-project install.

### Recommended: Claude Code plugin (~2 minutes)

```
# In Claude Code:
/plugin marketplace add kalyvask/chief-of-staff
/plugin install chief-of-staff@kalyvask
```

Then `cd` into the plugin cache directory (Claude Code prints the path) and run `npm install && npm run setup` once to fill in `.env` and seed the context files. After that, the plugin's slash commands (`/am-sweep`, `/brief`, `/cal-shape`, etc.) are available in any Claude Code session, and the SessionStart hook prints a one-line status check. Update with `/plugin update chief-of-staff@kalyvask`. Uninstall with `/plugin uninstall chief-of-staff@kalyvask`.

### Alternative: clone and run locally (for scheduled overnight jobs)

The CLI install is needed if you want to wire the scheduled `/email-triage` and `/calendar-prep` runs to Task Scheduler or cron.

```bash
git clone https://github.com/kalyvask/chief-of-staff.git
cd chief-of-staff
npm run setup        # npm install, prompts for env vars, content wizard, doctor
```

The setup orchestrator opens the right URL in your default browser at each step (Anthropic console, Gmail App Password page, Slack app config) and waits for you to paste back. Anything you skip can be set later in `.env`.

After setup, wire Gmail and Calendar. Two paths in `MCP_SETUP.md`:

- **Composio-managed (~3 minutes):** sign up at `app.composio.dev`, paste the API key, run `npm run composio:connect`. Composio hosts the OAuth and the MCP server.
- **Self-hosted (15-20 minutes):** create your own Google Cloud project, enable Gmail + Calendar APIs, download `gcp-oauth.keys.json`. Everything stays on your machine.

Verify everything is wired:

```bash
npm run doctor                    # full check: filesystem, services, substrate
npm run doctor:quick              # skip the live network calls
npm run check:anthropic           # one service at a time
npm run check:smtp
npm run check:mcp
```

Register the overnight jobs (one command, OS-detected):

```bash
npm run schedule                  # prompts before writing
npm run schedule -- --apply       # non-interactive
npm run schedule -- --list        # show what is currently scheduled
npm run schedule -- --unregister  # remove
```

On Windows this writes three `schtasks` entries (06:00 email triage, 06:15 calendar prep, 06:30 hooks runner). On macOS / Linux it edits your crontab.

See the seeded demo before committing to setup:

```bash
npm run cos:demo                  # seed 8 sample queue items + a demo project, then start the server
npm run cos:demo:cleanup          # close all demo items, remove the demo project
```

### Alternative: Docker

```bash
docker compose up --build              # server on http://localhost:3030
docker compose run --rm setup          # interactive setup inside the container
docker compose --profile tools run --rm demo   # seeded demo
```

## Subagents

- `chief-of-staff`: default router. Reads the full context library and handles routine requests directly.
- `email-drafter`: drafts Gmail replies and outbound emails. Delivers each draft to your own inbox via `send-to-self.mjs`, prefixed `[CoS Draft]`, with the intended recipient stated in the body. You copy or forward from there. No Gmail OAuth write scope required. Loads recent matching voice-prior exemplars before drafting (positive few-shot complement to the conform critic).
- `interview-prep`: specialist for interview, recruiter, hiring-manager, and founder-coffee prep. Reads an optional sibling `../llm-wiki/` story bank if present.
- `relationship-curator`: maintains `memory/relationships.md` after meetings and surfaces relationships that have gone cold (more than 60 days since the last interaction, configurable).
- `meeting-coach`: tactical critique on meetings just held. Reads the Granola transcript, the relationship history, and prior debriefs for the same person. Produces three observations tied to specific transcript moments or cross-meeting patterns, a landing read on tone, and extracted commitments. Also captures up to three voice exemplars per meeting to `data/voice-priors.jsonl`, which `email-drafter` loads as positive few-shot examples (the agent-to-agent learning loop). Invoked by `/debrief`.
- `stakeholder-researcher`: drafts a `context/stakeholders.md` entry for a new person from Gmail history and a brief web search (LinkedIn, company page, recent talks). Cites sources; leaves judgment-call fields blank for me to fill. Invoked by `/discover`.

## Slash commands

- `/am-sweep`: morning entry point. Reads the open queue first, then overnight files, today's calendar, recent inbox, `tasks.md`, and `memory/relationships.md`. Classifies new signals into Dispatch/Prep/Yours/Skip, writes them to the queue, dispatches subagents in parallel after approval.
- `/brief`: lighter morning view. Three short paragraphs in prose: what is on the plate, what is slipping, the one thing not to forget.
- `/prep <meeting>`: one-page meeting brief. Pulls from `stakeholders.md` and `memory/relationships.md`. For interviews, also pulls 2-3 stories from `../llm-wiki/wiki/stories/` if present.
- `/debrief [meeting]`: post-meeting coaching. Pulls the Granola transcript, dispatches `meeting-coach` for a tactical critique, drafts a relationship update via `relationship-curator`, queues commitments, appends an entry to `memory/meetings.md` for the graph. Requires Granola MCP at user scope (see `MCP_SETUP.md`).
- `/discover <name> [email]`: research a new person from Gmail and a brief web search, draft a `stakeholders.md` entry for approval. Cites sources; never invents.
- `/bootstrap-relationships [days]`: one-shot backfill from the last N days of Granola (default 90). Drafts proposed entries for `relationships.md`, `stakeholders.md` candidates, and `meetings.md`, then rebuilds the graph.
- `/cal-shape`: shapes the week ahead. Pulls the next five business days of calendar, classifies each event keep / decline / shift / batch / no-op, writes proposals as Yellow queue items, drafts the outbound messages via `email-drafter`. Does not move the calendar; tier-3 actions handle that later after explicit approval.
- `/voice <text>`: rewrites pasted text to strip em dashes and AI tells. Cleanup pass.
- `/critique <text>`: structural critique against a 12-dimension rubric (BLUF, warmth, jargon load, AI tells, structural opener, others). Diagnostic; does not rewrite.
- `/conform <text>`: runs `tools/conform-cli.mjs` over pasted text. Catches em dashes, AI tells, flattery, banned email phrases, bullet-salad briefs, missing sources footer. Returns a structured report; offers a clean rewrite when high-severity hits exist.
- `/digest`: runs the weekly compaction (`tools/compact.mjs`). Folds the last 7 days of closed queue items, decisions, and counterparty traffic into `memory/digest-YYYY-Wnn.md`. `/am-sweep` reads this at the top of the morning so the working set stays light.
- `/commit [slug:] <decision>`: appends a dated entry to `memory/decisions.md` with stakeholders and alternatives considered. If a project slug is supplied (`/commit anthropic-pm-interview: ...`), also writes to `projects/<slug>/decisions.md`.
- `/retro`: weekly retrospective. Audits command usage, flags context files past their 14-day freshness window, writes the audit to `memory/learnings.md`.
- `/email-triage` (overnight): reads the last 24 hours of inbox, classifies, proposes tasks. Writes to `logs/email-triage-YYYY-MM-DD.md`. Read-only.
- `/calendar-prep` (overnight): pulls tomorrow's calendar, computes drive times if `GOOGLE_MAPS_API_KEY` is set, pulls attendee context. Writes to `logs/calendar-prep-YYYY-MM-DD.md`. Read-only by default.
- `/search <query>`: ranked passages from `context/`, `memory/`, and `projects/` with `path:line` references. BM25 by default; vectors added if `VOYAGE_API_KEY` is set.
- `/think <question>`: synthesized answer over the same retrieval layer, with `[path:line]` citations and a `Gaps:` list of what the corpus does not cover.
- `/contradictions`: heuristic scan for conflicts between `memory/decisions.md`, `context/priorities.md`, `memory/relationships.md`, and the queue. No LLM; expect some false positives.

## Working with the substrate

The work queue, permission engine, conformance audits, typed graph, weekly digest, and event-driven hooks are agent-aware but you can drive them by hand too.

```
# Work queue
npm run queue -- list                          # open items
npm run queue -- list --overdue
npm run queue -- list --project <slug>
npm run queue -- list --direction out          # things I owe
npm run queue -- list --direction in           # things owed to me
npm run queue -- show <id>
npm run queue -- claim <id> --actor email-drafter    # inter-agent lock
npm run queue -- release <id> --actor email-drafter
npm run queue -- close <id> --outcome "<note>"
npm run queue:md                               # render data/queue.md (human view)
npm run queue:compact                          # rewrite JSONL, keep latest snapshot per id

# Permission engine
npm run permit -- check --action email.archive --actor email-drafter
npm run permit -- raise --actor email-drafter --tier 1 --reason "trust earned on newsletter archive"
npm run permit -- list                         # action catalog
npm run permit -- actors                       # current actor tiers

# Conformance audits (encode the voice rules as code)
echo "draft text..." | npm run conform -- audit --kind email --item <id>
echo "brief text..." | npm run conform -- audit --kind brief

# Typed-link graph
npm run graph                                  # regenerate data/graph.json from Markdown + queue + projects
npm run graph:query -- warm-list-dormant 60    # stakeholders not touched in 60+ days (merges relationships.md and meetings.md signals)
npm run graph:query -- open-for <stakeholder-id>
npm run graph:query -- project <slug>          # items + decisions for a project
npm run graph:query -- commitments-out         # things I owe
npm run graph:query -- unresolved              # queue items with counterparties not in stakeholders.md
npm run graph:query -- meetings-with <id> [days]   # meetings attended with this person (default 90 days)
npm run graph:query -- relationship-rhythm <id>    # first / last / avg cadence per stakeholder
npm run graph:query -- mentioned-not-met [min]     # attendees in 2+ meetings not yet in stakeholders.md

# Weekly digest
npm run digest                                 # write memory/digest-YYYY-Wnn.md
npm run digest -- --window-days 14 --dry-run

# Event-driven hooks (wake on signals, not just on schedule)
npm run hooks                                  # run all hooks in tools/hooks/*.mjs once
npm run hooks -- --only overdue                # run a single hook
npm run hooks -- --only red-alert              # Slack DM on new Yours/high items
npm run hooks -- --only classification-drift   # surface bucket-share shifts vs 23d baseline

# Retrieval and synthesis
npm run retrieve:index                         # build data/retrieval-index.json
npm run retrieve:search -- "<query>"           # ranked passages
npm run think -- "<question>"                  # synthesized answer with citations

# Contradiction scan
npm run contradictions

# Regression evals
npm test                                       # synonym for npm run eval, deterministic substrate only
npm run eval -- --only conform                 # filter by suite
npm run eval:agent                             # agent classification, 15 fixtures, needs ANTHROPIC_API_KEY
npm run eval:agent -- --threshold 0.85         # stricter pass bar
npm run eval:agent -- --k 5                    # pass^k=5: per-fixture pass rate + variance
npm run eval:adversarial                       # 18 adversarial fixtures, threshold 0.95
npm run eval:drafter                           # email-drafter quality, 10 fixtures

# Voice priors (positive few-shot complement to the conform critic)
npm run voice-priors -- list                   # most recent voice exemplars
npm run voice-priors -- list --tag decline     # filter by tag
npm run voice-priors -- add --context "..." --exemplar "..." --tags decline,recruiter
npm run voice-priors -- stats                  # counts by type, tag, source

# Observability
npm run drift                                  # bucket distribution shift (last 7d vs prior 23d)
npm run cost-report                            # token + latency rollup from data/telemetry.jsonl
npm run cost-report -- --days 7 --by actor     # last 7d, grouped by actor instead of command

# Substrate stats
npm run stats                                  # aggregate state from queue / permit / conform / graph
npm run stats -- --json                        # machine-readable

# Health checks
npm run check:freshness                        # fail if any required context/memory file > 21 days stale
npm run check:scheduler                        # walk every layer the overnight run depends on
npm run check:slack                            # auth.test against SLACK_BOT_TOKEN (or webhook-only mode)

# First-run wizard (interactive; writes initial context files)
npm run init                                   # prompts 6 questions
npm run init -- --from-json answers.json       # non-interactive
```

Every queue item must carry provenance (the upstream signal it came from). Every side-effect action goes through `permit check` first; every decision lands in `data/permit-audit.jsonl`. Every draft is audited against `tools/conform.mjs` before delivery.

## Talking to the agent

Four surfaces, in rough order of how often you will reach for them.

**Slack** (recommended primary interface). @-mention the bot from any channel or DM the agent directly. The mention writes a Yellow queue item, drafts a reply, and posts back in-thread. `/approve q_xxx` and `/close q_xxx` close the loop without leaving Slack. The agent also DMs you when a Red item lands, via the `red-alert` hook at [`tools/hooks/red-alert.mjs`](tools/hooks/red-alert.mjs). Two-tier setup: outbound-only via webhook (~3 minutes, push notifications only) or full bidirectional via bot token + tunnel (~20 minutes, talk to the agent from anywhere). See [SLACK_SETUP.md](SLACK_SETUP.md).

**Inside Claude Code, in this directory.** Open Claude Code from the project root. The slash commands and the six subagents load automatically. User-scoped Gmail, Calendar, and optionally Granola MCP tools are available. Best for daily desktop work: morning `/am-sweep`, per-meeting `/prep`, post-meeting `/debrief`, decision `/commit`, weekly `/retro`.

**Standalone CLI** (`npm run cos -- "your prompt"`). Reads `CLAUDE.md` as the system prompt and inherits user-scoped MCP servers from `~/.claude.json`. Used as the target of scheduled overnight runs.

**Local web UI** (`npm run ui`, then open `http://localhost:3030`). Browser-based streaming chat with the same agent. Includes a tasks panel and an editor for the whitelisted context and memory files. The server also exposes REST endpoints for the work queue, the tier table, the permit engine, per-project state, and the maintenance audit.

Mobile capture (separate from running commands): pin `memory/relationships.md`, `memory/decisions.md`, and `tasks.md` in a Markdown editor over OneDrive. See [MOBILE.md](MOBILE.md).

## email-drafter and the self-send pattern

The `email-drafter` subagent never emails third parties directly. It produces a drafted reply and ships it to your own inbox via `send-to-self.mjs`, which is hard-coded to use `SELF_EMAIL` as the recipient. The body of the self-email states the intended external recipient, the thread reference, and the drafted text. You read it, copy or forward, and send the real reply yourself.

This is a deliberate safety design. Even if the agent misclassifies an email or hallucinates a recipient, the worst case is a draft landing in your own inbox. No third party is contacted.

SMTP credentials come from one of two `.env` files, in this order: the project's `.env` (preferred), or `../role-radar/.env` as a fallback. For Gmail SMTP, you need an App Password from `https://myaccount.google.com/security` (not your real Gmail password).

## Scheduled overnight runs

On Windows, register the two batch files via PowerShell:

```powershell
$cosDir = (Resolve-Path .).Path
$settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName "cos email triage" `
  -Action (New-ScheduledTaskAction -Execute "$cosDir\run-email-triage.bat") `
  -Trigger (New-ScheduledTaskTrigger -Daily -At 6:00am) `
  -Settings $settings -Force

Register-ScheduledTask -TaskName "cos calendar prep" `
  -Action (New-ScheduledTaskAction -Execute "$cosDir\run-calendar-prep.bat") `
  -Trigger (New-ScheduledTaskTrigger -Daily -At 6:15am) `
  -Settings $settings -Force
```

On macOS or Linux, use cron:

```cron
0  6 * * * cd /path/to/chief-of-staff && claude -p "/email-triage"  --dangerously-skip-permissions >> logs/scheduler.log 2>&1
15 6 * * * cd /path/to/chief-of-staff && claude -p "/calendar-prep" --dangerously-skip-permissions >> logs/scheduler.log 2>&1
```

Both jobs are read-only by default, so unattended runs are safe.

If a scheduled run produces a fail-mode log (the agent declined to fabricate output because its dependencies were not available), diagnose with:

```
npm run check:scheduler
```

The script reports pass / warn / fail per layer (working directory, batch files, `.mcp.json`, Google OAuth credentials, claude CLI on PATH, Task Scheduler entries, today's logs, fail-mode streak). It points at the layer that broke instead of the whole pipeline going silent.

## Customize the repo for yourself

The repo ships with one author's identity and context as a worked example. Replace these with your own:

1. **`CLAUDE.md`**: replace the "Who I am" section with your own paragraph (role, current focus, what you are optimizing for). Edit the "Hard rules" section with the voice patterns you want stripped. Leave the triage taxonomy and "What to read first" sections as-is.
2. **`AGENTS.md`**: usually mirrors `CLAUDE.md`. Edit to match.
3. **`context/stakeholders.md`**: one entry per person who shows up in your week.
4. **`context/priorities.md`**: the 3-7 things actively on your plate.
5. **`context/career_thesis.md`** (rename to fit your role): what you are optimizing for over the next 6-12 months.
6. **`context/operating_principles.md`**: how you make decisions and run your week.
7. **`context/research_arc.md`** (optional, if you write publicly).
8. **`memory/*.md`** and **`tasks.md`**: empty out the example entries. Personal entries belong in `*.local.md` siblings, not the tracked file. `memory/relationships.local.md`, `memory/meetings.local.md`, `memory/decisions.local.md` are gitignored via `*.local.md`. The graph reads each tracked template plus its `.local.md` merged, so populated data stays out of git. `/bootstrap-relationships`, `/debrief`, `relationship-curator`, and `/commit` all write to the `.local.md` versions.

If you keep your personalized versions of any file alongside the tracked template, the convention is to suffix the personal copy with `.local.md` (e.g. `AGENTS.local.md`, `tasks.local.md`). The `.gitignore` excludes `*.local.md` so your content stays out of public history.

The agent is only as good as the files it reads. After every meeting that matters, spend 60 seconds updating `memory/relationships.md`. When priorities shift, update `context/priorities.md` the same day. Stale context makes the agent generic.

## Optional integrations

These are sibling repos the system can call out to. None are required.

- [`../pm-evaluation-framework/`](https://github.com/kalyvask/pm-evaluation-framework): the public PM skill library. The boundary is described above; install the framework skills user-wide so they are available in every Claude Code session including the chief-of-staff plugin.
- [`../llm-wiki/`](https://github.com/kalyvask/llm-wiki): a personal knowledge base of STAR-format stories, frameworks, and company notes. `/prep` and `interview-prep` read from it if present.
- [`../role-radar/`](https://github.com/kalyvask/role-radar): a PM job matcher and interview-prep generator. The `interview-prep` subagent invokes `role-radar prep <cv> --review` and `role-radar debug "Company"` via Bash when warranted.
- [`../winning-writing/`](https://github.com/kalyvask/winning-writing): a draft-critique toolkit with a 12-dimension rubric. `/critique` invokes its skills.

## How it works

Twelve modular layers (context library, memory, projects, queue, permit engine, conformance, graph, digest, hooks, inbound channels, subagents, evals) plus three surfaces (in-Claude-Code, CLI, web UI). The internal layout, file map, and self-send safety pattern are documented in [`docs/architecture.md`](docs/architecture.md).

## Voice rules

Enforced by `CLAUDE.md`. The repo ships with a strict no-em-dashes / no-AI-tells rule set. Customize the banned-word list to your own voice. The point is to have a fixed set the agent enforces before drafting anything on your behalf.

## Notes

- Read-only OAuth is the default for Gmail and Calendar. The email-drafter uses SMTP to your own inbox, so Gmail OAuth write scopes are not required. To enable drive-time event insertion in `/calendar-prep`, add the `calendar.events` scope per `MCP_SETUP.md`.
- The repo name has a historical typo (`chief-off-staff`) in some older clones; the package, working directory, and identity use the correct spelling.
- The system runs entirely locally. No data leaves your machine except Anthropic API calls, Google API calls, and SMTP to your own configured server.

## Slack configuration

Two tiers, depending on whether you want push-only or full bidirectional. The walkthroughs below are the operational steps; [`SLACK_SETUP.md`](SLACK_SETUP.md) has the same flow with more detail.

### Tier 1: webhook push (3-5 minutes)

For receiving server-pushed messages (red-alert DMs, scheduled job notifications). No public tunnel needed. You CANNOT talk to the agent from Slack with this setup.

1. Create the app at <https://api.slack.com/apps> → **Create New App → From scratch** → name `chief-of-staff` → pick your personal workspace.
2. Left nav: **Features → Incoming Webhooks** → toggle on → **Add New Webhook to Workspace** → pick a destination (recommend creating `#cos-alerts` first, or use the app's own DM channel for direct push).
3. Copy the webhook URL (`https://hooks.slack.com/services/...`).
4. Add to `.env`:
   ```
   SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
   ```
5. Verify wiring:
   ```bash
   npm run check:slack                                              # → ok: true, webhook-only mode
   node tools/slack-respond.mjs --webhook --text "test"             # → lands in your channel
   ```
6. Round-trip the red-alert hook:
   ```bash
   npm run queue -- add --bucket Yours --priority high --summary "test red-alert" --source eval --actor test
   npm run hooks -- --only red-alert                                # → alert in Slack
   ```
7. (Optional) Schedule the hooks runner to fire every 30 minutes via Task Scheduler so red-alert fires automatically.

### Tier 2: full bidirectional (20-30 minutes)

Adds: @-mention or DM the bot from any device and get a real-time LLM reply (Sonnet, ~3-5s latency). Requires a public HTTPS tunnel so Slack's Event API can reach `server.mjs` on your laptop.

1. **Bot scopes + token.** Same app config → **Features → OAuth & Permissions** → Bot Token Scopes: add `app_mentions:read`, `chat:write`, `channels:history`, `im:history`, `im:write`. Scroll up, click **Install to <workspace>** → **Allow**. Copy the **Bot User OAuth Token** (`xoxb-...`).
2. **Signing secret.** **Settings → Basic Information → App Credentials → Signing Secret** → Show → copy.
3. **App Home messages.** **Features → App Home** → toggle **Messages Tab** on → check **Allow users to send Slash commands and messages from the messages tab**. Without this, Slack silently blocks DMs to the bot with "Sending messages to this app has been turned off".
4. Add to `.env`:
   ```
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_SIGNING_SECRET=...
   ```
5. Verify:
   ```bash
   npm run check:slack                                              # → team: <workspace>, bot: <bot-user>, no soft-mode warning
   ```
6. Install cloudflared (one-time; or use ngrok if you prefer):
   ```powershell
   winget install --id Cloudflare.cloudflared
   ```
7. Start the server (terminal 1, leave running):
   ```bash
   npm run ui                                                       # → Chief of Staff UI running at http://localhost:3030
   ```
8. Start the tunnel (terminal 2, leave running):
   ```bash
   cloudflared tunnel --url http://localhost:3030                   # → prints https://<random-words>.trycloudflare.com
   ```
9. Slack app config → **Features → Event Subscriptions** → toggle on → **Request URL**: paste `<tunnel-URL>/api/slack/event` → wait for green **Verified** check → **Subscribe to bot events**: add `app_mention` and `message.im` → **Save Changes**.
10. DM the bot in Slack with `hello`. You should see a real-time reply within a few seconds. The server stdout logs `[slack event]` for every inbound and `[slack reply]` for every outbound.

### Gotchas

- **App Home "Allow users to send" checkbox is OFF by default.** Without it, Slack silently blocks DMs with "Sending messages to this app has been turned off". No error reaches the server.
- **Quick-tunnel URLs are ephemeral.** Every cloudflared restart yields a new URL. For permanent use, set up a named tunnel with your Cloudflare account (free).
- **Server + tunnel die when their terminals close** (or after laptop sleeps too long). For persistent setup, run them as detached PowerShell jobs or scheduled tasks.
- **Signing secret missing puts the endpoint in soft mode** (accepts unsigned requests). `npm run check:slack` reports it. Production should always have `SLACK_SIGNING_SECRET` set.
- **Bot echo loop**: the bot's own replies fire the same `message.im` event back at the server. The endpoint filters via `!event.bot_id` to prevent infinite loops.

### Optional polish

- **`SLACK_ALERT_CHANNEL`** in `.env` (set to your bot DM channel ID like `Dxxxxxxxx`) makes red-alert post via bot token to that DM instead of via webhook. Cosmetic but consistent: alerts then appear under the bot's identity alongside the conversational replies.
- **Named cloudflared tunnel** with your Cloudflare account: `cloudflared tunnel login`, `tunnel create chief-of-staff`, `tunnel route dns chief-of-staff <subdomain>`, then `tunnel run chief-of-staff`. Stable URL across reboots; paste in Slack once.
- **Richer reply context**: the default `SLACK_REPLY_SYSTEM` prompt in `server.mjs` is intentionally generic. Extend it to load top stakeholders, current priorities, and open queue items if you want replies that reflect your actual day. Trade-off: bigger prompts cost more per Slack message.

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "Sending messages to this app has been turned off" | App Home checkbox unchecked | Step 3 of Tier 2 |
| Slack URL verification stays grey or red | Tunnel not running, server not running, or `/api/slack/event` blocked | Verify both backgrounds; from a browser, hit `https://<tunnel>/api/slack/event` (should 401 bad signature) |
| Bot does not reply but server log shows event arrived | Anthropic API key missing or quota exhausted | Look for `[slack reply] anthropic error` lines |
| Bot reply has em dashes or AI tells | `SLACK_REPLY_SYSTEM` voice rules too loose | Tighten the prompt in `server.mjs` |
| Red-alert posts but DMs don't reply | Tier 1 wired, Tier 2 not | Walk through Tier 2 from Step 1 |

## License

ISC. Fork and use it.
