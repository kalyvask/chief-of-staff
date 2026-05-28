---
description: Coach me through a meeting I just had. Pulls the Granola transcript, dispatches meeting-coach for a tactical critique, drafts a relationship update, and queues commitments.
argument-hint: [optional: meeting name, attendee, or Granola meeting id; defaults to most recent Granola meeting today]
mode: approval-required
---

You are debriefing me on a meeting. The raw input is: $ARGUMENTS

## Parse the input

If `$ARGUMENTS` is empty, query the Granola MCP for the most recent meeting today via `list_meetings` or `query_granola_meetings`. If there is no Granola meeting from today, say so and ask which meeting I want to debrief. Do not silently grab yesterday's.

If `$ARGUMENTS` looks like a Granola meeting id, pass it directly to `get_meeting_transcript`.

Otherwise treat `$ARGUMENTS` as a meeting name or attendee name. Query Granola for matching meetings in the last 7 days. If there are multiple matches, list them with date and title and ask which one. Do not guess.

## Steps

1. Read `CLAUDE.md` for voice rules.
2. Pull the Granola transcript via the Granola MCP `get_meeting_transcript`.
3. Identify the attendees. The transcript may name them; cross-check against the matching Google Calendar event for the same date and time window if the names are unclear.
4. For any attendee not in `context/stakeholders.md`, prompt me for a two-sentence profile and add the entry before continuing. Do not invent a profile.
5. Dispatch the `meeting-coach` subagent with the meeting id, the attendee list, and the transcript text. Wait for it to finish.
6. The coach writes its brief to `logs/debrief-YYYY-MM-DD-<slug>.md`. Read that file and present its findings inline so I do not have to open the file to see them.
7. Ask three approval questions in order:
   - Which of the critique points (1, 2, 3, all, or none) to log to `memory/learnings.md` so `/retro` can surface patterns
   - Which commitments to queue (name each one explicitly)
   - Whether to dispatch `relationship-curator` to apply the proposed relationship update

## After my approval

For each commitment I approve, write a queue item:

```
node tools/queue-cli.mjs add \
  --bucket Prep \
  --priority <high|med|low> \
  --due <YYYY-MM-DD if mentioned, otherwise omit> \
  --summary "<one-line commitment>" \
  --source granola \
  --source-id "<granola meeting id>" \
  --direction <out|in> \
  --counterparty "<name>" \
  --proposed-action "<one sentence>" \
  --required-tier <0|1|2|3 based on action class> \
  --provenance '{"type":"granola.meeting","ref":"<meeting-id>","captured_at":"YYYY-MM-DD"}' \
  --actor debrief \
  --rule debrief.commitment
```

For each critique point I approve to log, append a one-line entry to `memory/learnings.md` under today's date, citing the debrief filename. The point of logging is pattern detection over time, not journaling.

If I approve the relationship update, dispatch `relationship-curator` with the proposed text for each affected stakeholder. The curator writes the actual update to `memory/relationships.local.md` (gitignored personal data; the tracked `memory/relationships.md` stays as a template). Confirm both writes happened.

After the queue and relationship writes, append a meeting entry to `memory/meetings.local.md` (newest at top of the entries area; create the file from the template header if it does not exist). This is what makes the meeting visible to the typed-link graph as an `attended` node:

```
## <YYYY-MM-DD>: <meeting title>
**Granola ID:** <uuid>
**Attendees:** <names matching stakeholders.md where possible>
**Topic:** <one-line topic; reuse the title if no better summary exists>
**Decisions:** <decision ids from /commit, or "none">
**Commitments:** <queue ids you just wrote, comma-separated, or "none">
**Debrief:** logs/debrief-YYYY-MM-DD-<slug>.md
**Project:** <slug if the meeting maps to one, otherwise "unscoped">
```

After all writes, refresh the queue Markdown view and rebuild the graph:

```
node tools/queue-md.mjs
node tools/build-graph.mjs
```

The graph rebuild is what lets `meetings-with`, `relationship-rhythm`, and `warm-list-dormant` pick up this meeting in subsequent queries.

## Failure modes

- **No Granola transcript available.** Do not fabricate. If the meeting is real but the transcript is missing, ask whether to write a calendar-only debrief (flagged in the first line as "calendar-only, no transcript") or to skip. Default to skip.
- **Coach output is generic.** If the critique points read as advice that could apply to any meeting with any human, push the coach back once with the specific failed point quoted back. If the second pass is still generic, say so in your response and let me decide whether to keep the brief or discard it. Do not paper over a weak critique.
- **Attendee not in `stakeholders.md`.** Prompt me. Offer two options: (1) I give a two-sentence profile inline, or (2) run `/discover <name> [email]` first to draft a researched entry from Gmail history and a brief web search. Do not run the coach on an unknown stakeholder, because the relationship-specific bar in the critique requires the stakeholder profile.
- **Multiple Granola matches with the same name.** List them with date and the first 50 characters of the title. Ask me which one.

## Voice constraints

No em dashes. No AI tells. Direct. The brief comes from the coach; your job is parsing the input, dispatching the coach, presenting findings, asking for approvals, and writing the queue plus memory updates after approval.
