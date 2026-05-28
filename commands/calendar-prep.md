---
description: Overnight calendar prep. Pulls tomorrow's calendar, calculates drive times if a Maps key is set, writes a Markdown prep file to logs/.
mode: read-only
---

You are running my overnight calendar prep. This typically runs at 5:45 or 6:15 AM. The goal is to walk into the day with each meeting already understood.

## Steps

1. Read `CLAUDE.md` for voice rules.
2. Pull today's and tomorrow's Google Calendar events.
3. For each event:
   - If the event has a physical location, calculate drive time from my likely starting point at that time of day (home in the morning, previous meeting's location otherwise). Use the Google Maps Directions API if `GOOGLE_MAPS_API_KEY` is set in the env. Include a 10-minute traffic buffer for events between 7 AM and 9:30 AM or between 4 PM and 6:30 PM. If the env var is not set, estimate from prior knowledge and flag the estimate as an estimate.
   - If the event has attendees, pull each attendee's snapshot from `context/stakeholders.md` and the latest line from `memory/relationships.md`.
   - If the event is an interview or recruiter call, also pull 2-3 relevant stories from `../llm-wiki/wiki/stories/`.

4. Identify back-to-back meetings without buffers and flag them.
5. Identify any conflicts (overlapping events, traffic-induced lateness, missing video links for remote meetings).

## Output

Write a Markdown file to `logs/calendar-prep-YYYY-MM-DD.md` with one section per meeting in chronological order. Each section:

### <Time> <Meeting title>
- Location and drive time (or "remote" / "walking on campus")
- Attendees (name and one-line relationship)
- The 2-3 things I want from this meeting
- The 1-2 things they likely want
- One risk
- (Interviews only) 2-3 stories to have ready with file slugs

End the file with a "Watch for" section listing any conflicts, missing buffers, drive-time risks, or items that need my attention.

## Drive-time events

If `calendar.events` write scope is enabled in the Google OAuth scopes, propose drive-time events in the file output first ("Drive to <location>: leave at <time>, est <duration>"). Wait for my go-ahead in `/am-sweep` before inserting them as actual calendar events. Do not insert without explicit approval.

If write scope is not enabled, write the drive-time information into the prep file only.

## Voice

No em dashes. No AI tells. Tight. The whole file should read like a Sunday-evening prep for Monday.
