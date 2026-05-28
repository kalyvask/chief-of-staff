# Projects

Per-project state lives here. One subfolder per active project, named by slug (lowercase, dashes). The slug is the same string the queue and `/commit` use as `--project`.

The `context/` folder describes who I am and what I am working on in general. `projects/<slug>/` is where the running state of a specific initiative lives, so the agent does not have to reconstruct "what is happening with X?" every time from scratch.

## Layout per project

```
projects/<slug>/
  status.md         What is happening right now, last touched, confidence, blockers.
  decisions.md      Project-scoped decision log. Mirrors memory/decisions.md schema.
  commitments.md    What I owe to whom, what is owed to me, due dates.
  notes.md          Running notes, links, references, ad-hoc context.
```

`memory/decisions.md` is the global ledger across all projects (and life). `projects/<slug>/decisions.md` is the project-scoped slice. `/commit` writes to both when the decision carries a `--project` slug, so cross-project visibility stays intact while project-scoped context is also dense.

## Conventions

- Slug: short, lowercase, dashes. Examples: `anthropic-pm-interview`, `substack-paper-2`, `gsb-touchy-feely`. Do not use spaces, slashes, or quotes.
- Every file has a `Last updated: YYYY-MM-DD` line at the top so the maintenance audit can flag staleness.
- Status confidence is a single letter: H (high), M (med), L (low). Used by `/am-sweep` to weight what to surface.
- Closed projects move to `projects/_archive/<slug>/` so the active list stays uncluttered. Archive only after the last open queue item closes.

## Starting a new project

```
cp -r projects/_template          projects/<slug>          # generic project
cp -r projects/_template-pipeline projects/<slug>          # recruiting, fundraising, sales, partner outreach
cp -r projects/_template-travel   projects/<slug>          # a trip, a conference week, an onsite visit
```

Then edit each file. Touch `status.md` first; the others can fill in as the project develops.

The pipeline template adds `contacts.md` (stage-aware contact list) in place of `commitments.md`. The travel template adds `reservations.md` (chronological booking list) in place of `commitments.md`. Both keep `status.md`, `decisions.md`, and `notes.md` with the same shape as the generic template.

## Reading order for the agent

Before responding to anything that references a project, the agent should read in this order:

1. `projects/<slug>/status.md`
2. `projects/<slug>/commitments.md`
3. `projects/<slug>/decisions.md`
4. `projects/<slug>/notes.md`
5. Open queue items where `project == <slug>`

Anything that contradicts a decision in #3 is a Red surface, not a draft.
