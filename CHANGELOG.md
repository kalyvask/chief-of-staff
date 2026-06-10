# Changelog

## 1.0.0 (2026-06-09)

First tagged release.

Core:
- Four-bucket triage taxonomy (Dispatch / Prep / Yours / Skip) over a JSONL work queue with claim/release locking, undo, and provenance on every item.
- Tier-based permission engine (`tools/permit.mjs`): action classes, per-actor tiers, approval gates on tier-2/3, full audit log. Enforced at the tool layer via the Agent SDK `canUseTool` hook (`tools/enforce.mjs`): calendar/email MCP writes are denied unless a fresh allowed permit check exists in the audit log.
- Typed-link knowledge graph built from Markdown + queue + projects, with relationship-rhythm, dormant-stakeholder, and commitment queries.
- Conformance audits (voice rules as code), weekly digest compaction, event-driven hooks, BM25 retrieval with optional vectors, contradiction scan.

Commands:
- `/am-sweep` morning triage, `/brief`, `/prep`, `/debrief`, `/discover`, `/bootstrap-relationships`, `/cal-shape`, `/voice`, `/critique`, `/conform`, `/digest`, `/commit`, `/retro`, `/email-triage` and `/calendar-prep` (overnight), `/search`, `/think`, `/contradictions`.
- `/weekly-plan`: Monday planning ritual. Elicits the week's one primary goal and the 48-hour must-dos, reconciles them against the next 7 days of calendar, applies the cadence-floor rule (`tools/planner.mjs`) to find recurring 1:1s safe to skip, flags relationships gone cold to reconnect, proposes deep-work blocks, writes everything as tier-3 queue proposals.
- `/execute-approved`: the one command that writes the calendar. Permit-checked per item, plan shown before any write, single recurring instances only, notifications off.

Guardrails:
- Context budget (`tools/context-budget.mjs`): keeps a command's working set under 40% of the context window; over budget, it names the compressible contributors and the offload (digest, retrieval, queue query).
- Per-command MCP tool scoping (`tools/tool-scope.mjs` + `data/tool-scopes.json`): each slash command sees only the MCP servers it needs.
- Scheduled overnight runs use explicit `--allowedTools` lists, never a permissions bypass.

Channels and surfaces:
- Web UI (`server.mjs`) with SSE chat, queue/projects/audit panels, opt-in API token auth, loopback binding by default.
- Slack: webhook red-alerts and bidirectional replies with live state context. Forwarded-email ingestion with shared-secret auth.
- Claude Code plugin install path; Docker compose with a no-keys demo mode.

Verification:
- 69-check deterministic suite (`npm test`) covering conformance, permits, queue, graph, retrieval, entities, contradictions, and the self-tested rule engines (planner, context-budget, tool-scope, enforce); wired to GitHub Actions.
- LLM eval suites for triage classification (15 fixtures), adversarial classification (18 fixtures, 0.95 threshold), email-drafter quality (10), and Slack-reply quality (10).
