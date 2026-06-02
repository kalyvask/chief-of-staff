---
description: Execute approved calendar items. Takes queue items I have already approved and, only if permit() allows, makes the real Google Calendar write (skip a recurring instance, create a focus block, reschedule). This is the one command that actually touches the calendar.
mode: autonomous
---

You are executing calendar items I have already approved. This is the only command that calls a Google Calendar write tool. It runs in autonomous mode so the permit engine's tier ceiling does not block tier-3 actions, but every single write is still gated three ways: the item must be `approval_state=approved`, the executing actor must be raised to tier 3, and you must show me the plan and get my go-ahead before any write.

The proposals come from `/weekly-plan` and `/cal-shape`. The approval happens in `/am-sweep`. Execution happens here. Nothing else in the system writes the calendar.

## Step 1 - Gather approved, unexecuted calendar items

```
node tools/queue-cli.mjs list --all
```

Keep only items where ALL of these hold:
- `approval_state === "approved"`
- `status` is not `done` or `dropped` (not already executed)
- `source === "calendar"` or `actor` is `weekly-plan` / `cal-shape`
- provenance carries a `calendar.event` ref (the event id to act on)

If none qualify, say so and stop. Do not go looking for new work.

## Step 2 - Map each item to an action and a permit check

Decide the action class from the item's summary / proposed_action:

| Item intent | Action class | Calendar tool |
|---|---|---|
| skip this week / cancel one recurring instance I organize | `calendar.cancel` | `delete_event` on the specific occurrence id (or `respond_to_event` declined if I am only an attendee, not the organizer) |
| focus block / deep-work hold | `calendar.create-focus-block` | `create_event` on my own calendar, no other attendees |
| shift / reschedule a 1:1 | `calendar.reschedule` | `update_event` with the new start/end |

For each item, run the permit check before doing anything:

```
node tools/permit-cli.mjs check --action <action> --actor calendar-actor --item <queue-id>
```

Exit 0 / `allowed:true` means proceed. Exit 1 / `allowed:false` means STOP for that item and report the reason verbatim. The common denial is `actor calendar-actor at tier 0; action ... requires tier 3` - that means I have not enabled execution yet. In that case tell me to run, once:

```
node tools/permit-cli.mjs raise --actor calendar-actor --tier 3 --reason "enable approved calendar execution"
```

and re-run this command. Never work around a denial.

## Step 3 - Show the plan, get my go-ahead

List every item that passed its permit check: the queue id, the event title and time, the exact calendar write you will make, and whether it notifies anyone. Then ask me to confirm. Do not write anything until I say go. If I name a subset, only do those.

## Step 4 - Execute

For each confirmed item, in order:

1. Make the calendar write with notifications OFF (`notificationLevel: "none"` / `sendUpdates: "none"`). If the write would notify another person and I have not explicitly said to notify, keep it silent and note that a heads-up draft is still sitting in my inbox from the proposal step.
   - **Skip a recurring instance:** delete only the single occurrence (use the instance event id from the calendar pull), never the whole series. If I am an attendee and not the organizer, decline that one instance with `respond_to_event` instead.
   - **Focus block:** `create_event` on my primary calendar, the proposed slot, title from the item, no attendees, mark me busy.
   - **Reschedule:** `update_event` to the new start/end only.
2. On success, close the queue item so it is not re-executed:
   ```
   node tools/queue-cli.mjs close <queue-id> --outcome "executed: <one-line what happened, incl. new event id or 'instance deleted'>" --actor calendar-actor
   ```
3. On any tool error, leave the item open, record the error in your report, and move on. Do not retry blindly.

After all writes, run `node tools/queue-md.mjs` to refresh `data/queue.md`.

## Step 5 - Report

Write `logs/execute-approved-<today>.md`: one line per item with the queue id, what was written (or skipped, with reason), and the resulting event id. End with counters: items considered, executed, skipped-by-permit, errored.

## Voice

No em dashes. No AI tells. Terse. State plainly what touched the calendar and what did not.

## What you do not do

You do not act on any item that is not `approval_state=approved`. You do not raise your own tier (only I can, via permit-cli). You do not delete an entire recurring series when the item asks to skip one instance. You do not send notifications to other people without my explicit say-so. You do not invent items that were never proposed and approved.
