---
description: Heuristic scan for contradictions across memory/decisions.md, context/priorities.md, memory/relationships.md, and the queue. Catches "I decided to ship X then closed q_... with outcome 'abandoned X'", antonym decisions on the same project, stale priority claims, and cadence claims with no recent evidence.
argument-hint: [--today YYYY-MM-DD]
mode: read-only
---

You are running a contradiction audit. The point is to catch drift between what I have written down as the truth (decisions, priorities, relationships) and what the queue and graph actually show happened. This is heuristic, not LLM, so false positives are possible. Treat each finding as a candidate.

## Steps

1. Read `CLAUDE.md` for voice rules.
2. Ensure `data/graph.json` is fresh: if missing or older than 7 days, run `node tools/build-graph.mjs` first.
3. Run `node tools/contradictions-cli.mjs --json` and read the findings.
4. Group by severity (high, med, low). For each finding:
   - Name the rule (e.g. `decision-vs-outcome`).
   - Quote the contradiction in one sentence using the evidence the finding carries.
   - State the suggested reconciliation.
5. End with a one-line summary: how many findings, by severity, and which reconciliations I should do today vs which can wait.

## Rules in scope today

- **decision-vs-outcome (high):** a decision in `memory/decisions.md` is contradicted by the closed outcome of a queue item in the same project (antonym verbs across the two).
- **decision-vs-decision (med):** two decisions on the same project point opposite directions.
- **stale-priority (med):** a `context/priorities.md` item carries an embedded date older than its bucket window (14 days for this-week, 35 days for this-month).
- **relationship-claim-vs-evidence (low):** `memory/relationships.md` claims an active cadence (weekly, monthly, regular) but the graph has no logged interaction or recent meeting.
- **queue-direction-mismatch (low):** an open inbound queue item is older than closed outbound items to the same counterparty; the original ask may be dead.

If I tell you a rule is wrong or missing a pattern, edit `tools/contradictions.mjs` directly. The rules are code, not prose.

## What to do, what to drop

For each high-severity finding, the default action is to add a "Superseded by:" line to the earlier decision in `memory/decisions.md`. For med and low, surface them; do not edit anything without asking me.

## Voice

No em dashes. No AI tells. If there are no findings, say "no contradictions" in one sentence and stop.
