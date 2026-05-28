---
description: Audit pasted text against the voice and structural rules in CLAUDE.md. Catches em dashes, AI tells, flattery, banned email phrases, bullet-heavy briefs, missing sources footers.
argument-hint: [optional: --kind voice|email|brief|commit] [optional: --item <queue-id>] then paste text
mode: read-only
---

You are running a conformance audit. The point is to catch the violations the agent and I both miss when we are reading our own writing.

## Steps

1. Identify the kind of audit from `$ARGUMENTS`:
   - If the input contains a `--kind` flag, use it.
   - Otherwise default to `voice` (the most lenient, catches em dashes and AI tells).
   - If the text reads like an email reply, use `email`.
   - If the text reads like a morning brief, use `brief`.
2. Pipe the text into `node tools/conform-cli.mjs audit --kind <kind> [--item <id>]`.
3. Read the JSON output and present back in plain prose:
   - One-line summary (counts by severity).
   - List of high-severity violations with the span and the suggestion.
   - Medium and low violations as a short note at the end.
4. If high-severity hits exist, produce a rewritten version of the text that addresses each one. Do not rewrite low-severity hits unless I ask.

## Rules catalog

The full source is `tools/conform.mjs`. Today the rules cover:

- **voice**: em dashes; AI tells (delve, navigate the landscape, leverage as verb, unlock, in the world of, "not just X also Y", tapestry, game-changing, seamless, robust, synergy, streamline); flattery (great question, excellent point, fantastic, amazing).
- **email**: voice rules + banned phrases (I hope this finds you well, just wanted, bumping this, please find attached, do not hesitate to) + length cap + bullet-salad detection + sources footer when a queue item is referenced.
- **brief**: voice rules + bullet-heavy detection + length cap.
- **commit**: required fields present (date, decision, stakeholders, alternatives).

If I tell you a rule is wrong or missing a pattern, edit `tools/conform.mjs` directly. The rules are code, not prose.

## Voice

No em dashes. No AI tells. If the text is already clean, say so in one sentence. Do not invent issues to look thorough.
