# Chief of Staff: How to Use

Three surfaces. Pick the right one for the task.

## Surface 1: Inside Claude Code, in this directory (most powerful)

When you open Claude Code in `chief-of-staff/`, the slash commands `/am-sweep`, `/brief`, `/prep`, `/voice`, `/critique`, `/commit`, `/retro`, `/cal-shape`, `/email-triage`, `/calendar-prep`, and `/graph-query` are loaded. You also get the four subagents (`chief-of-staff`, `email-drafter`, `interview-prep`, `relationship-curator`). This surface has access to user-scope Gmail and Calendar tools. Use it for anything that needs live email, calendar, draft messages, meeting prep, or grounding in your real schedule.

**Daily pattern:**

1. `/am-sweep` first thing in the morning. Reads any overnight files in `logs/`, today's calendar, recent inbox, `tasks.md`, and `memory/relationships.md`. Classifies open items into Dispatch / Prep / Yours / Skip. Dispatches subagents in parallel after your approval.
2. `/brief` is the lighter alternative when you want the three-paragraph view without the full sweep.
3. `/prep <meeting name>` 30 to 60 minutes before any non-trivial meeting. For interviews it also reads your story bank from `../llm-wiki/wiki/stories/` if present. Output is a one-pager.
4. After a meeting or decision, `/commit <decision>` to log it to `memory/decisions.md`. Then invoke the `relationship-curator` subagent, or update `memory/relationships.md` directly, for any person you just spent time with.
5. End of week, `/retro`. Audits which commands you used, which context files went stale, what to update next week.

`/voice <pasted text>` strips em dashes and AI tells from anything you wrote or generated elsewhere. `/critique <pasted text>` runs the structural pass (BLUF, warmth, jargon load, rubric scoring).

`/cal-shape` shapes the week ahead. It pulls the next five business days of calendar, classifies each event into keep / decline / shift / batch / no-op, drafts the outbound messages via `email-drafter`, and writes the proposals as Yellow queue items. It does not move the calendar; that happens later via a tier-3 action on the specific item after you approve.

`/commit anthropic-pm-interview: decided to lead with the Substack paper as cold open` writes to `memory/decisions.md` and also to `projects/anthropic-pm-interview/decisions.md`. Drop the slug prefix to write only to the global log.

## The work queue

`data/queue.jsonl` is the canonical store for everything in flight. Open items survive across mornings. `/am-sweep` reads it first, before any inbox or calendar pull. The queue lib lives at `tools/queue.mjs` and the CLI at `tools/queue-cli.mjs`:

```
node tools/queue-cli.mjs list
node tools/queue-cli.mjs list --overdue
node tools/queue-cli.mjs list --project anthropic-pm-interview
node tools/queue-cli.mjs list --direction out         # things I owe
node tools/queue-cli.mjs list --direction in          # things owed to me
node tools/queue-cli.mjs show q_2026-05-19_004
node tools/queue-cli.mjs add --bucket Yours --priority high --due 2026-05-22 \
    --summary "Decide intro phrasing for Peter" --source manual \
    --provenance '{"type":"manual","ref":"hallway-chat"}' --actor cli
node tools/queue-cli.mjs update q_2026-05-19_004 --status drafted --actor email-drafter
node tools/queue-cli.mjs close q_2026-05-19_004 --outcome "sent and replied"
node tools/queue-cli.mjs compact          # rewrite the JSONL keeping only the latest snapshot per id
node tools/queue-md.mjs                    # render data/queue.md (human-readable view)
```

Every queue item must carry `provenance` citing its upstream signal (email id, calendar event id, manual note). Drafts derived from the queue should include a `Sources:` footer built via `tools/provenance.mjs`.

## The permission engine

Side-effect actions go through a tier check before they run. Action classes and required tiers live in `data/tiers.json`. The tier ladder is:

- **0** Read, draft to inbox, write to queue, write to memory, write to logs (current default for all subagents)
- **1** Inbox and calendar housekeeping (archive newsletters, label threads, decline calendar spam)
- **2** Short acknowledgments and routine 1:1 reschedules
- **3** Pre-approved item execution, only against a queue item with `approval_state=approved`

```
node tools/permit-cli.mjs check --action email.archive --actor email-drafter
node tools/permit-cli.mjs check --action email.send-external --actor email-drafter --item q_2026-05-19_004
node tools/permit-cli.mjs raise --actor email-drafter --tier 1 --reason "trust earned on newsletter archive"
node tools/permit-cli.mjs list             # show the action catalog
node tools/permit-cli.mjs actors           # show current actor tiers
```

Every decision lands in `data/permit-audit.jsonl`. If a subagent calls a tool that should have gone through `permit()` and did not, the missing audit row is the tell.

## Per-project state

`projects/<slug>/` holds the working state for an active initiative. Layout per project: `status.md`, `decisions.md`, `commitments.md`, `notes.md`. The agent reads these before responding to anything that names the project. See `projects/README.md` for the convention. Start a new project by copying the template:

```
cp -r projects/_template projects/<slug>
```

## Surface 2: The standalone CLI (`node index.mjs`)

For headless or scripted runs:

```
npm run cos -- "summarize today's schedule and the top 3 unread emails"
npm run cos -- "draft a reply to <recipient> confirming tomorrow's <time> call"
npm run cos -- "what is on my plate today, paragraph form, no bullets"
```

The CLI inherits user-scoped MCP servers from `~/.claude.json` and is the target of the scheduled overnight jobs.

## Surface 3: The context library itself (highest leverage)

The agent is only as good as the files it reads. Treat the five files in `context/` as living documents, not setup paperwork. The discipline that pays off:

- After every meeting that matters, spend 60 seconds updating `memory/relationships.md`. A one-line "Last interaction: <date>, <channel>, <one-sentence summary of what was discussed and what was left open>" is what makes the next `/prep` for that person useful instead of generic.
- When priorities shift, update `priorities.md` immediately. If a major commitment lands or falls away, `priorities.md` should change that day. Stale priorities make `/brief` and `/am-sweep` lie.
- `career_thesis.md` should be revisited monthly, not weekly. It is the constitution. Changing it should feel deliberate.
- `stakeholders.md` grows over time. Every new mentor, recruiter, founder, or recurring meeting partner gets an entry. The fields that matter most are "what they care about" and "what I want from this relationship over 6-12 months."

## Scheduled overnight runs (optional)

`/email-triage` and `/calendar-prep` are designed to run unattended overnight and write a Markdown file to `logs/` that `/am-sweep` reads the next morning. Two batch files ship with the repo (`run-email-triage.bat`, `run-calendar-prep.bat`) for Windows Task Scheduler.

Register via PowerShell:

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

Both jobs are read-only by default, so unattended runs are safe. The first manual run after setup triggers OAuth consent in the browser; later runs are silent.

## /am-sweep, the morning entry point

`/am-sweep` reads the overnight files (if present), today's calendar, recent inbox, `tasks.md`, and `memory/relationships.md`, classifies every open item into Dispatch / Prep / Yours / Skip, and asks which Green and Yellow items to dispatch. After approval, it fires the named subagents in parallel (`email-drafter`, `interview-prep`, `relationship-curator`, default `chief-of-staff`) and reports back when each finishes.

## email-drafter and the self-send pattern

The `email-drafter` subagent never emails third parties directly. It produces a drafted reply and ships it to your own inbox via `send-to-self.mjs`, which is hard-coded to deliver to `SELF_EMAIL`. The body of the self-email states the intended external recipient, the thread reference, and the drafted text. You read it, copy or forward, and send the real reply yourself.

This is a deliberate safety design. Even if the agent misclassifies an email or hallucinates a recipient, the worst case is a draft landing in your own inbox. No third party is contacted.

## Hard rules

The agent reads `CLAUDE.md` before responding. That file enforces: no em dashes, no AI tells, no flattery, no external sends without explicit approval, critical evaluation of pasted AI outputs. If the agent breaks any of those, call it out and it should self-correct. If it does not, edit `CLAUDE.md` to make the rule sharper.

## Failure modes to watch for

- **Stale context.** If `/brief` or `/am-sweep` feels generic, almost always the cause is that `priorities.md` or `relationships.md` has not been touched in 10+ days. Run `/retro` and clean up.
- **Drift in voice rules.** If drafts start sounding AI-shaped, paste a recent one into `/voice` and see what gets stripped. If `/voice` keeps making the same swaps, add the offending word or pattern as a new rule in `CLAUDE.md`.
- **The agent saying yes too easily.** Voice rules tell it to push back. If it stops, log the failure in `memory/learnings.md` so `/retro` catches it.
- **email-drafter not delivering.** Check that `SELF_EMAIL` and SMTP credentials are set in `.env` (or that `../role-radar/.env` has the `ROLE_RADAR_SMTP_*` set as fallback). The script prints which env var is missing.
- **MCP tools not in standalone scripts.** The CLI inherits user-scoped servers from `~/.claude.json`. If Gmail or Calendar are not wired there, the CLI is text-only until they are.

## Suggested first week

1. Fill in `context/stakeholders.md`, `context/priorities.md`, `context/career_thesis.md`, and `context/operating_principles.md` with real entries. Don't aim for completeness; aim for the 5-10 stakeholders and 3-5 priorities that are actually active right now.
2. Edit the "Who I am" and "Hard rules" sections of `CLAUDE.md` and `AGENTS.md` to match your role and your voice.
3. Run `/prep` against your next meaningful meeting. Note where the output is useful and where it is generic.
4. After the meeting, run `/commit` and update `memory/relationships.md`.
5. Friday or Saturday, run `/retro`. See which commands earned their keep, which context files drifted.
6. Iterate. The system should feel sharper in week three than week one.
