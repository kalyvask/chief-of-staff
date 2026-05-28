---
description: One-shot backfill of memory/relationships.md and memory/meetings.md from the last N days of Granola history. Pulls all meetings, extracts attendees, drafts proposed entries, asks for approval before writing.
argument-hint: [optional: number of days to look back, default 90]
mode: approval-required
---

You are running the Granola relationship backfill. The raw input is: $ARGUMENTS

## Parse the input

If `$ARGUMENTS` is a positive integer, use that as the look-back window in days. Otherwise default to 90.

## Required reading

1. `CLAUDE.md` for voice rules.
2. `context/stakeholders.md` to know who already has a profile.
3. `memory/relationships.md` AND `memory/relationships.local.md` (the personal data lives in the `.local.md`) to know who already has a logged interaction.
4. `memory/meetings.md` AND `memory/meetings.local.md` to know which meetings are already logged.

The graph reads both the tracked template and the gitignored `.local.md` merged, so all writes from this command go to the `.local.md` versions to keep personal data out of git.

## Steps

1. Call the Granola MCP `get_account_info` to get the user's email. This is the identity to exclude when extracting attendees.
2. Compute today's date and `today - N days`. Use ISO YYYY-MM-DD format.
3. Call the Granola MCP `list_meetings` with `time_range: "custom"`, `custom_start: <today-N>`, `custom_end: <today>`. If the response is more than 200 meetings, ask whether to narrow the window before proceeding.
4. For each meeting, parse `known_participants`. Drop the user themselves. Drop entries that are only an email address with no name (those are usually calendar artifacts).
5. Build two views from the parsed data:

   **By person:** for each unique non-user attendee, capture:
   - Name (longest-form spelling if multiple variants)
   - Email domain (used to flag higher-leverage candidates: `stanford.edu`, `snowflake.com`, `anthropic.com`, `openai.com`, VC firms)
   - Count of meetings in the window
   - Most recent meeting date and title
   - First meeting date in the window
   - Whether already in `context/stakeholders.md` (by name match)
   - Whether already in `memory/relationships.md` (by name match)

   **By meeting:** for each meeting not already in `memory/meetings.md` (match by Granola id), capture:
   - Granola id
   - Date and title
   - Attendee list (names only)
   - Topic guess: use the meeting title verbatim if short, otherwise extract the first noun phrase

6. Dedupe both views against what's already on disk. If both views are empty after dedup, say so and stop. Do not write empty diffs.

## Present for approval

Show three blocks. Keep each block tight.

### Block 1: People to add to relationships.md

A short table:

| Name | Meetings | Most recent | Already in stakeholders.md |
|------|----------|-------------|----------------------------|
| ...  | ...      | ...         | yes / no                   |

For each row, draft the proposed `memory/relationships.md` entry inline:

```
## <Name>
- Last interaction: <YYYY-MM-DD>, granola, <most recent meeting title>
- Open threads: (to confirm)
- Cares about: (to confirm)
- Meetings in window: <N> meetings between <first-date> and <last-date>
```

Ask: "Approve all? Approve specific numbers? Skip?"

### Block 2: People worth promoting to stakeholders.md

Filter to people with EITHER:
- Three or more meetings in the window, OR
- An email domain in a watch list (stanford.edu, snowflake.com, anthropic.com, openai.com, vc/founder firms you recognize)

For each candidate, draft a one-line proposed `context/stakeholders.md` entry:

```
### <Name>
**Origin:** met via Granola backfill from <first-date>
**Cadence:** <N> meetings in last <window> days
**What they care about:** _To fill in._
**What I want from this relationship over 6-12 months:** _To fill in._
```

Append these under a new H2 "## Backfilled from Granola" if no fitting category exists.

Ask: "Which to add? Numbers or 'none'."

### Block 3: Meetings to add to meetings.md

Show count only plus 5 sample titles. Do not dump the full list.

Each meeting entry written will be:

```
## <YYYY-MM-DD>: <title>
**Granola ID:** <uuid>
**Attendees:** <names>
**Topic:** <one-line topic from title>
**Decisions:** none
**Commitments:** none
**Debrief:** none
**Project:** unscoped
```

Ask: "Approve all meeting entries? (yes/no)"

## After approval

For each approved relationship entry, append (newest at top of the entries area) to `memory/relationships.local.md`. Create the file from the template header if it does not exist yet. Never overwrite an existing `## <Name>` header; if the name already exists, skip and report.

For each approved stakeholder entry, append to `context/stakeholders.md` under the appropriate category (or "## Backfilled from Granola"). This file is tracked; only commit if you want the stakeholder names public.

For each approved meeting entry, append (newest at top) to `memory/meetings.local.md`. Create the file from the template header if it does not exist yet.

Then run:

```
node tools/build-graph.mjs
```

To refresh the graph with the new meeting nodes and `attended` / `last_meeting_at` edges.

## Show the final summary

A four-line summary:

- Wrote `<N>` entries to `memory/relationships.md`
- Wrote `<N>` entries to `context/stakeholders.md`
- Wrote `<N>` entries to `memory/meetings.md`
- Graph rebuilt: now has `<N>` meeting nodes, `<N>` attended edges, `<N>` unresolved attendees

Then suggest two follow-ups:

- `node tools/graph-query.mjs warm-list-dormant 60` to see who is now dormant given the fresh data
- `node tools/graph-query.mjs mentioned-not-met 2` to see attendees that appeared 2+ times but were not promoted to stakeholders.md

## Failure modes

- **Granola MCP not available.** Stop. Say so. Point at `MCP_SETUP.md`.
- **More than 200 meetings in the window.** Ask to narrow before proceeding.
- **Attendee name format ambiguous.** When a name appears with slight spelling variants ("Mouhssine Rifaki" vs "Mouhssine R"), pick the longest version and flag it in the row.
- **No new entries after dedup.** Say so and skip the write step. Do not produce an empty diff.
- **An attendee shows up only as an email with no display name.** Skip and add to a separate "Could not resolve" list in the summary.

## Voice constraints

No em dashes. No AI tells. Direct. The point of this command is to populate the relationship layer from real meeting data, not to fabricate context. If a field would need to be invented (Open threads, Cares about, What I want from the relationship), leave it as `(to confirm)` rather than make something up.
