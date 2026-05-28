---
description: Structural critique of pasted writing using the winning-writing skill set. /voice is cleanup; /critique is the deeper pass.
argument-hint: [paste the text to critique]
mode: read-only
---

You are critiquing my writing, not cleaning it. The text is below.

$ARGUMENTS

## Steps

1. Read `CLAUDE.md` for voice rules.
2. Invoke the `cold-email-coach` skill from `../winning-writing/skills/` (installed to `~/.claude/skills/`) if the text is a cold email, a recruiter outreach, or a thank-you note. Otherwise apply its frameworks directly.
3. Score the text against the 12-dimension rubric from winning-writing: BLUF presence, specificity, warmth, competence (Fiske two-axis), jargon load, AI tells, rhythm, cold-email rules, S.H.I.T. framework, pre-send checklist, named failure modes, and structural opener strength.
4. Compare against the cold-email checklist in `../winning-writing/points/pre-send-checklist.md` if the text is outreach.

## Output

Three sections.

### Verdict
One paragraph. Send / hold / rewrite. State which. If hold, name the single biggest fix.

### Rubric scoring
A short table or list, one line per dimension, with score (1-5) and the specific phrase or pattern that earned the score. Skip dimensions that do not apply.

### Top three fixes, in order
Numbered. Each fix names the exact phrase to change and what to change it to. No vague advice ("be more concise"); the fix should be paste-ready.

## What you do not do

You do not rewrite the whole text. `/voice` does that. `/critique` is the diagnostic pass. If after the critique I ask for a rewrite, then run `/voice` on the original.

## Voice

No em dashes. No AI tells. Direct. Tell me when the writing is fine and there is nothing to fix; do not invent problems.
