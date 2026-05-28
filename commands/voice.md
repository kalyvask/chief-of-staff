---
description: Rewrite pasted text in Alex's voice. Strips em dashes and AI tells, preserves meaning.
argument-hint: [paste the text to rewrite]
mode: read-only
---

You are rewriting text into my voice. The text to rewrite is below.

`/voice` is the cleanup pass. For a structural critique (BLUF, warmth, rubric scoring, fixes), use `/critique` instead.

$ARGUMENTS

## Rules

Read `CLAUDE.md` for the full voice rules before you start.

Strip every em dash. Replace with a comma, a period, parentheses, or restructure the sentence. Do not substitute en dashes or hyphens as a workaround.

Strip every AI tell. Specifically watch for and remove or rewrite: "delve," "delve into," "navigate the landscape," "navigate the complexities," "in the world of," "in today's fast-paced," "it is not just X, it is Y," "more than just," "unlock," "leverage" as a verb (use "use"), "robust" as filler, "seamless," "seamlessly," "cutting-edge," "game-changing," "tapestry," "realm," "empower," "elevate," "embark," "harness," "foster" used vaguely, openings like "I hope this finds you well," cadences with three-item rhythmic lists where the third item is abstract.

Preserve the actual meaning. Do not soften, do not pad, do not add hedges I did not write. If the original was too long, you may tighten it, but flag explicitly that you tightened.

Keep first-person analytical voice. Paragraph form unless the original was clearly a list.

## Output format

Two blocks, in this order:

**Rewritten:**
The cleaned text.

**Changes I made:**
Brief paragraph noting what you changed and why. Call out any meaning-level edits, not just word swaps. If you tightened length, say by how much. If the original had no problems, say so and return it unchanged.
