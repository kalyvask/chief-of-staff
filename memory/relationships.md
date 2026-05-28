# Relationships: Interaction Log

Per-person notes from real interactions. The agent reads this before drafting any message, prep doc, or follow-up that touches the person in question.

**Personal entries live in `memory/relationships.local.md`** (gitignored via `*.local.md`). This file is the tracked template that ships with the repo. The graph reads both files merged, so populated entries land in your local copy and never enter git history.

Format per person:

```
## <Name> (<role / affiliation>)
**Last interaction:** YYYY-MM-DD, <channel>, <one-line summary>
**Recent landing:** YYYY-MM-DD, <how the last meeting felt and the momentum it left>
**Open threads:** what I owe them, what they owe me, anything unresolved
**Pattern to watch:** the recurring dynamic across our recent interactions, if any
**Sensitivities:** topics to handle carefully, stylistic preferences, anything personal worth knowing
**History highlights:** the 2-3 prior interactions that most define how this relationship reads today
```

`Recent landing` is the per-meeting tone read: did it land warm or tense, conclusive or punted, with momentum or stalled. The meeting-coach writes this after `/debrief`. `Pattern to watch` is the cross-meeting read: if the same dynamic shows up across two or three recent landings, name it so future briefs can prep against it.

---

_No entries in the tracked template. Your populated data lives in `memory/relationships.local.md`. Run `/bootstrap-relationships` to backfill from Granola, or `/debrief` after your next meeting._
