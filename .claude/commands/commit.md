---
description: Log a decision or commitment to memory/decisions.md and (if a project is named) to projects/<slug>/decisions.md.
argument-hint: [optional: project-slug:] [the decision in one sentence]
mode: approval-required
---

You are logging a decision. The raw input is: $ARGUMENTS

## Parse the input

If `$ARGUMENTS` starts with `<slug>:`, that prefix is the project slug. The rest is the decision text. Validate the slug against the folders in `projects/`. If the slug does not match any existing project folder, ask whether to create a new project folder (cp -r projects/_template projects/<slug>) or whether the slug is wrong.

If there is no slug prefix, the decision is unscoped. Write only to the global log.

## Gather missing pieces

If the decision text is empty or vague, ask three things before writing: what is the decision in one sentence, who is affected, and what alternatives I considered. Do not write the entry until you have all three.

If the decision text is clear but stakeholders or alternatives are missing, ask only for the missing pieces.

## Write the entry

Read the existing `memory/decisions.md` to match the format. Append a new entry at the **top** of the entries section, using exactly this format:

```
## YYYY-MM-DD: <one-line decision>
**Stakeholders:** <people affected or in the loop>
**Alternatives considered:** <what else was on the table and why I rejected it>
**Notes:** <anything worth remembering when I revisit this, or "none">
**Project:** <slug or "unscoped">
```

Use today's date. Do not invent stakeholders or alternatives. If I said "no real alternatives," write "no real alternatives" verbatim. The point of the log is honesty, not completeness theater.

If a slug was supplied, also append the same entry (without the trailing **Project:** line) to `projects/<slug>/decisions.md`. Bump the `Last updated:` line at the top of that file to today.

## Confirm

After writing, show me the entry as it now appears in `memory/decisions.md` and (if applicable) in `projects/<slug>/decisions.md`. Confirm both writes.

## Voice constraints

No em dashes. Plain direct prose in the Notes field.
