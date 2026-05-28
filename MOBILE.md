# Mobile capture cheat sheet

The point of mobile capture is to close the 30-second window after a meeting where the entry is still fresh. Long-form work stays on the laptop.

## Setup

Open the chief-of-staff folder in a Markdown editor on your phone that can read OneDrive. 1Writer (iOS) or Markor (Android) both work. Pin these three files to favorites:

- `memory/relationships.md`
- `memory/decisions.md`
- `tasks.md`

## What to capture, and how

### After a meeting that mattered, in `memory/relationships.md`

Append at the bottom (or update an existing entry):

```
## <Name> (<role / affiliation>)
**Last interaction:** YYYY-MM-DD, <channel>, <one line on what was discussed and what was left open>
**Open threads:** <what you owe them, what they owe you, anything unresolved>
**Sensitivities:** <topics to handle carefully, stylistic preferences>
**History highlights:** <2-3 prior interactions that define the relationship today>
```

Three rules:

1. The "Last interaction" one-liner is the load-bearing field. The other three can stay sparse and get filled in over time.
2. Use today's date in YYYY-MM-DD form. Phone keyboards make this fast.
3. If you cannot remember the channel, write `in person` or `call` and move on. Specificity beats accuracy at this stage.

### After a decision or commitment, in `memory/decisions.md`

Append at the top (newest first):

```
## YYYY-MM-DD: <one-line decision>
**Stakeholders:** <names, comma separated>
**Alternatives considered:** <what else was on the table>
**Notes:** <anything worth remembering when you revisit this>
```

If you cannot fill in alternatives in 10 seconds, write `none considered explicitly` and move on. The point of the log is honesty, not completeness theater.

### Quick task into `tasks.md`

Add a line under `## This week`:

```
- [ ] <action verb> <subject>
```

That is it. Do not nest, do not categorize. The morning `/am-sweep` on your laptop will classify it.

## What not to do from mobile

- Do not run slash commands from mobile. They need the agent loop.
- Do not edit `context/career_thesis.md` or `context/operating_principles.md` from mobile. Those are constitution-level and should feel deliberate; mobile encourages reactive edits.
- Do not edit `CLAUDE.md`. Voice rules and triage taxonomy are not mobile-tier work.

## Next morning

Your edits sync back to the laptop within seconds of save. The next `/am-sweep` and `/brief` automatically pick them up because both commands re-read the context library at the start of every run. There is no merge step.
