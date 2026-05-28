---
description: Generate (or refresh) the weekly digest from the queue, decisions log, and projects. One-page narrative of what shipped, what stayed open, and what to watch.
mode: read-only
---

You are running my weekly compaction. The goal is to compress the last week's work into one page so /am-sweep can read context without reading the whole closed queue every morning.

## Steps

1. Run `node tools/compact.mjs`. Default window is 7 days; pass `--window-days <N>` if I asked for a longer view.
2. Read the generated digest at `memory/digest-YYYY-Wnn.md` and verify the structure:
   - "What I shipped" with project + counterparty breakdowns
   - "What stayed open" with overdue list
   - "Decisions made" with optional project tags
   - "Patterns to watch" with auto-flagged anomalies
3. If anything in the digest contradicts what I told you this week, flag it before showing me the file. Stale data is worse than no data.
4. Surface the digest in the response, then point me to the file path. Do not paste the entire content unless I ask; show the top-level counters and the "Patterns to watch" section.

## When to run

Friday afternoon or Saturday morning, typically. Re-running on the same day overwrites the same week's file. If I am inside an ISO week with a previous digest, treat the previous one as a revisable draft, not a separate artifact.

## Voice

No em dashes. No AI tells. Tight. If the week was light, the digest should say so explicitly instead of padding.
