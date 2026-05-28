---
description: Morning triage. Reads the open queue plus today's signals, classifies new items into Dispatch/Prep/Yours/Skip, writes them to the queue, dispatches subagents in parallel after approval.
mode: approval-required
---

You are running my morning sweep. The goal is to convert a blank-slate morning into a triaged queue with concrete next actions.

## Steps

1. Read `CLAUDE.md` for voice rules and the triage taxonomy.
2. If a weekly digest exists at `memory/digest-YYYY-Wnn.md` for the current ISO week, read it first. It compresses last week's closes, decisions, and patterns into one page; the working set stays light.
3. Run `node tools/hooks-runner.mjs` so the event-driven hooks (overdue items, dormant projects, dormant warm-list stakeholders) write any new Yellow/Yours items before triage.
4. Load the open queue: `node tools/queue-cli.mjs list`. Anything still open from yesterday is the starting state, not something to re-discover.
5. Surface overdues at the top of the report: `node tools/queue-cli.mjs overdue`.
6. Read `context/priorities.md` for what is on my plate.
7. Pull today's Google Calendar entries. For each meeting, use `node tools/graph-query.mjs open-for <stakeholder-id>` to surface open items linked to the attendees so prep is one query, not five reads.
8. Pull unread Gmail from the last 24 hours.
9. Read `tasks.md` for unchecked items.
10. Read `memory/relationships.md` for any open threads with people I should be touching today.
11. If `logs/email-triage-<today>.md` or `logs/calendar-prep-<today>.md` exist from overnight runs, read them.

## Classify new signals

For every email, calendar event, task, or relationship thread that is not already represented in the open queue, classify into one of:

- **Dispatch (Green):** routine, low-stakes, fully handleable within the dispatched subagent's tier.
- **Prep (Yellow):** I will act, but a subagent can get it to 80%.
- **Yours (Red):** strategy, sensitive comms, anything that touches a relationship I care about, anything that conflicts with `context/operating_principles.md` or `memory/decisions.md`. Surface only.
- **Skip (Gray):** defer with a reason.

Default Yellow over Green when uncertain. Default Red over Yellow on anything that touches a person or a commitment.

## Write items to the queue

For every new item, write it to the queue with:

```
node tools/queue-cli.mjs add \
  --bucket <Dispatch|Prep|Yours|Skip> \
  --priority <high|med|low> \
  --due <YYYY-MM-DD or omit> \
  --summary "<one-line description>" \
  --source <gmail|calendar|tasks|relationships|logs> \
  --source-id "<thread id, event id, line ref>" \
  --sender "<if applicable>" \
  --proposed-action "<one sentence>" \
  --project "<slug if it maps to one>" \
  --required-tier <0|1|2|3 based on action class> \
  --provenance '<JSON object or array citing the upstream signal>' \
  --actor am-sweep \
  --rule sweep.classify
```

Provenance is required. Every item must cite where it came from (e.g. `{"type":"gmail.thread","ref":"abc123"}` or `{"type":"calendar.event","ref":"evt_456"}`).

For commitments (something I owe or that is owed to me), set `--direction out` or `--direction in` and `--counterparty "<name>"`.

## Output

Three sections.

### The plate today
The 2-4 things that actually matter today, named specifically, in paragraph form. Not a calendar dump. Lead with overdue queue items if any.

### Queue snapshot
A short list per bucket in order: Yours, Prep, Dispatch, Skip. One line per item with its queue id. For Prep and Dispatch, name the subagent you propose to dispatch (`email-drafter`, `interview-prep`, `relationship-curator`, or the default `chief-of-staff` agent).

### Approve to dispatch
Ask which Prep and Dispatch items to dispatch. Do not dispatch anything until I approve.

When I approve, for each approved item: update the queue with `approval_state=approved` (`node tools/queue-cli.mjs update <id> --approval approved --actor am-sweep`), then dispatch the named subagent and pass the queue item id. The subagent calls `node tools/queue-cli.mjs claim <id> --actor <name>` to transition the item to `in-flight` and lock it from concurrent work, then updates to `drafted` or `done` when finished.

After all subagents finish, run `node tools/queue-md.mjs` to refresh the Markdown view at `data/queue.md`.

## Voice

No em dashes. No AI tells. If today looks light, say it looks light. Do not invent urgency.
