---
description: Overnight email triage. Reads the last 24 hours of inbox, classifies, proposes tasks. Read-only. Writes a Markdown file to logs/ for the morning queue.
mode: read-only
---

You are running my overnight email triage. This typically runs unattended at 5:30 or 6:00 AM. The goal is to wake up to a queue rather than a blank inbox.

## Steps

1. Read `CLAUDE.md` for voice rules.
2. Pull all emails received in the last 24 hours.
3. For each email, determine:
   - Requires action? (yes / no)
   - Category (interview / recruiter, GSB / class, mentor / network, vendor / admin, newsletter, ignore)
   - Priority 1 to 4 (1 reserved for time-sensitive interview, recruiting, or commitment threads)
   - Implied deadline, if any

4. For action-required emails:
   - Check `tasks.md` for an existing related task; if no duplicate, propose a new task with a clear action verb, a link or message ID, priority, and a rough due date.
   - If the sender is in `context/stakeholders.md`, name the relationship in the proposal so I can see at a glance why this matters.

5. Flag any time-sensitive items (an interview confirmation needed today, a recruiter waiting on a yes) as the "morning alert" at the top of the output.

## Output

Write a Markdown file to `logs/email-triage-YYYY-MM-DD.md` with these sections, top to bottom:

### Morning alert
Anything I need to handle in the first 30 minutes of the day. One line each. Empty if nothing.

### Proposed tasks
A list of proposed new entries for `tasks.md`. Each line: `- [ ] <action verb> <subject> (from <sender>, <category>, P<priority>)`. Do not append to `tasks.md` directly; this is a proposal that `/am-sweep` will review.

### Archive candidates
Newsletters and promotional emails I can archive. Group by sender domain.

### Summary
One paragraph on what I should know about overnight email.

## Hard rules

No drafts created. This command runs without supervision and is read-only on the inbox. Drafting belongs to `email-drafter` and only after `/am-sweep` approval.
