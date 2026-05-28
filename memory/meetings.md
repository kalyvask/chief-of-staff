# Meetings: Log

Lightweight log of meetings that should be in the typed-link graph. Each entry links a meeting to its attendees, the Granola transcript (if any), and any decisions, commitments, or debrief that came out of it.

**Personal entries live in `memory/meetings.local.md`** (gitignored via `*.local.md`). This file is the tracked template that ships with the repo. The graph reads both files merged.

Populated by:

- `/debrief` appends an entry to `memory/meetings.local.md` after a meeting is debriefed.
- `/bootstrap-relationships` does a one-shot backfill from the last N days of Granola history into `memory/meetings.local.md`.
- Manual edits to `memory/meetings.local.md` when neither path applies.

Format per meeting:

```
## YYYY-MM-DD: <Meeting title>
**Granola ID:** <uuid or "none">
**Attendees:** Name1, Name2
**Topic:** <one-line topic or theme>
**Landing:** <one-line tone read: warm/tense, conclusive/punted, momentum/stalled>
**Decisions:** <decision id, comma-separated, or "none">
**Commitments:** <queue ids like q_2026-05-21_004, comma-separated, or "none">
**Debrief:** <logs/debrief-...md path, or "none">
**Project:** <slug or "unscoped">
```

The graph builder reads this template plus your `.local.md`, emits `attended`, `commitment_from`, `decision_from`, `meeting_in_project`, and `last_meeting_at` edges. Names in `Attendees` are resolved against `context/stakeholders.md`; unresolved names land as `attended_unresolved` edges and surface via `node tools/graph-query.mjs mentioned-not-met`.

---

_No entries in the tracked template. Your populated data lives in `memory/meetings.local.md`._
