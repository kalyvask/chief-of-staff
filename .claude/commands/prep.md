---
description: One-page meeting prep brief. Pulls from stakeholders.md and relationships.md.
argument-hint: [meeting name or attendee]
mode: read-only
---

You are preparing me for a meeting. The meeting is: $ARGUMENTS

## Steps

1. Read `CLAUDE.md` for voice rules.
2. Read `context/stakeholders.md` for the attendee's profile and what I want from the relationship over the next 6-12 months.
3. Read `memory/relationships.md` for the most recent interaction with this person and any open threads.
4. Read `context/priorities.md` and `context/research_arc.md` to understand what I am currently working on that this person could touch.
5. **If the meeting is an interview, recruiter screen, hiring-manager call, or founder coffee:** also read relevant pages from the LLM Wiki at `../llm-wiki/wiki/`. Specifically pull from `wiki/stories/` for STAR-format stories I might want to deploy, `wiki/companies/<company-slug>.md` if the company is in there, `wiki/frameworks/` for any PM or leadership framework that fits the role, and `wiki/product-thinking/` or `wiki/technical-depth/` for relevant substance. Surface the 2-3 stories I should have ready for this specific conversation.
6. If no meeting was specified in the arguments, ask me which meeting before producing anything. Do not guess.
7. If the attendee is not in `stakeholders.md`, say so explicitly. Offer two paths: (a) I give you a two-sentence profile inline, or (b) run `/discover <name> [email]` first to draft a researched entry from Gmail history and a brief web search. Do not continue with the prep brief until the stakeholder is on file.

## Output format

A single one-page markdown brief with these five sections, in this order, each kept tight:

### Attendee snapshot
2-3 sentences. Who they are, what they care about, the relationship in one line.

### Last interaction
One line: date, channel, what we discussed, what was left open.

### Three things I want from this meeting
Numbered list. Specific and outcome-shaped, not topical. "Get a warm intro to X" not "discuss network."

### Two things they likely want
Numbered list. From their seat, what would make this meeting worth their time. Be honest, including if the answer is "not much, this is a favor."

### One risk
A single sentence on the thing most likely to go wrong. The misread, the topic to handle carefully, the ask I should not make today.

### Stories to have ready (interview meetings only)
If the meeting is an interview or recruiter conversation, list 2-3 specific stories from `../llm-wiki/wiki/stories/` that fit the role and the likely question types, with one line on what each demonstrates and the file slug so I can re-read it. Skip this section for non-interview meetings.

## Voice constraints

No em dashes. No AI tells. First-person voice in any phrasing about what I want. Tight prose. The whole brief should fit on one screen.
