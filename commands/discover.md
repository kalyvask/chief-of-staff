---
description: Research a new person from Gmail history and a brief web search, draft a context/stakeholders.md entry for approval. Use after meeting someone new, before /prep on an unknown attendee, or when /debrief flags a missing stakeholder.
argument-hint: <Name> [email]
mode: approval-required
---

You are drafting a stakeholder entry from real-world research. The raw input is: $ARGUMENTS

## Parse the input

Extract a name and (optionally) an email address.

- If `$ARGUMENTS` is empty, ask which person.
- If `$ARGUMENTS` is a single token that could be either a first name or an email, ask which it is.
- If multiple names are passed (comma or "and"), process them one at a time, not in parallel; the user approves each.

## Steps

1. Read `CLAUDE.md` for voice rules.
2. Read `context/stakeholders.md`. If a name match already exists, stop and report which entry matched; suggest editing the existing one rather than duplicating.
3. Dispatch the `stakeholder-researcher` subagent with the name and email. Wait for it to finish.
4. Show me the proposed entry inline so I do not have to open the subagent's output separately.
5. Ask one question: approve as-is, edit a specific field, or skip.

## After my approval

Append the entry to `context/stakeholders.md`. Choose the category by matching against existing H2 sections:

- Existing sections include: Mentors, Recruiting network, Founder relationships, Recruiting loops in progress, Personal.
- If a clear match exists, append under that section.
- If no section fits, append under a new `## Backfilled from /discover` H2 at the bottom of the file (or under an existing one if it was created on a prior `/discover` run).

Confirm the write happened by reading back the entry as it now appears in the file.

Then rebuild the graph so the new stakeholder shows up in queries:

```
node tools/build-graph.mjs
```

If `memory/meetings.md` has any `attended_unresolved` entries for this person's name, they will now resolve to the new stakeholder id on the next build. Note that in the confirmation.

## Failure modes

- **Subagent reports the person is already in `stakeholders.md`.** Stop. Report which entry matched.
- **Gmail and web passes both came back empty.** Show the (mostly empty) draft and ask whether to add a bare entry with just name and origin, or skip.
- **The user changes one field.** Apply the edit and re-show before writing.

## Voice constraints

No em dashes. No AI tells. The researched fields should cite sources (URLs, thread counts, dates). Do not paper over a thin research result by inventing what they care about.
