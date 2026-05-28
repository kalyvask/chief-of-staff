---
description: Weekly retrospective. Audits command usage, flags stale context files, proposes updates.
mode: read-only
---

You are running my weekly retrospective on the Chief of Staff system itself. The point is to keep the system honest and prevent the context library from rotting.

## Steps

1. Read `CLAUDE.md` for voice rules.

2. Regenerate the derived graph: run `node tools/build-graph.mjs` from the project root. The output is `data/graph.json`. Use it during the audit (placeholder count, stale relationships, decisions without matching stakeholders).

3. Audit slash command usage over the past 7 days. Look at `logs/` for any usage records. If logs are empty or missing, ask me directly which of `/am-sweep`, `/brief`, `/prep`, `/voice`, `/critique`, `/commit`, `/graph-query` I actually used this week and how often. Note which commands I never touched.

4. Audit context file freshness. For each file in `context/`, check the "Last updated:" line. Flag any file whose last-updated date is more than 14 days old, or whose content still contains placeholder text like `_To fill in_`. Cross-reference against `data/graph.json` `stats.placeholder_count` for the count.

5. Audit `memory/decisions.md` and `memory/relationships.md`. Are decisions actually being logged? Are relationships being updated after meetings? Use `data/graph.json` `stats.stale_relationship_count` and the `no_logged_interaction` edges to find specific stakeholders missing an interaction log.

6. Read `memory/learnings.md` and check whether last week's "proposed updates" actually got implemented. If not, ask why.

## Output format

Paragraph form. Three short sections with markdown headers.

### What worked this week
What commands or context files actually earned their keep. Be specific. "I used /prep four times and the Tom Loverro one saved me from forgetting the IVP fund timing question" beats "/prep was useful."

### What did not
Dead commands, prompts that produced fluff, contexts that went stale. Name them. If I am not using a command at all, propose either fixing it or deleting it.

### Proposed updates for next week
Concrete edits to specific files. Then ask me which to apply. Do not edit anything in `context/` or `CLAUDE.md` without my explicit go-ahead. You may write the audit itself to `memory/learnings.md` immediately, in the format already at the top of that file.

## Voice constraints

No em dashes. No flattery. If the system is barely being used, say so. The retro is most useful when it tells me uncomfortable things.
