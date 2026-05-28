// Chief of Staff: local web UI server.

import dotenv from "dotenv";
dotenv.config({ override: true });

import express from "express";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFile, writeFile, stat, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, normalize, sep } from "node:path";
import {
  loadOpen, loadQueue, getItem as getQueueItem,
  addItem as qAdd, updateItem as qUpdate, closeItem as qClose,
  queryOverdue, queryByProject, queryByBucket, queryByDirection,
  undoItem as qUndo, loadHistory as qHistory,
} from "./tools/queue.mjs";
import { loadTiers, permit as permitCheck, raiseActor } from "./tools/permit.mjs";
import { postSlack } from "./tools/slack-respond.mjs";
import { loadSlackContext, SLACK_REPLY_SYSTEM_BASE } from "./tools/slack-context.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3030;
// Bind to loopback by default. The web UI is a local desktop surface; mobile
// access goes through Slack, not this server. Override HOST only when you
// deliberately expose it (e.g. behind Tailscale), and set COS_API_TOKEN too.
const HOST = process.env.HOST || "127.0.0.1";
// Opt-in shared secret. When set, every /api route requires it (via the
// X-COS-Token header, an Authorization: Bearer value, or a ?token= query),
// except the webhook routes that authenticate themselves. Unset = no gating,
// which is safe only because HOST defaults to loopback.
const API_TOKEN = process.env.COS_API_TOKEN || "";

const DEMO_MODE = process.env.COS_DEMO === "1" || process.env.COS_DEMO === "true";
if (!process.env.ANTHROPIC_API_KEY && !DEMO_MODE) {
  console.error("ANTHROPIC_API_KEY not set. Check your .env file, or run in demo mode (COS_DEMO=1).");
  process.exit(1);
}
if (DEMO_MODE) {
  console.log("Chief of Staff: demo mode active. Chat endpoint returns a stub; substrate panels render real data.");
}

const systemPrompt = await readFile(resolve(__dirname, "CLAUDE.md"), "utf8");

// Whitelist of files the UI can read and write. Anything else is rejected.
const EDITABLE = new Set([
  "context/stakeholders.md",
  "context/priorities.md",
  "context/research_arc.md",
  "context/career_thesis.md",
  "context/operating_principles.md",
  "memory/decisions.md",
  "memory/relationships.md",
  "memory/learnings.md",
  "tasks.md",
  "CLAUDE.md",
  "USAGE.md",
]);

const READONLY = new Set(["USAGE.md"]);

function safePath(rel) {
  if (typeof rel !== "string") return null;
  const normalized = normalize(rel).split(sep).join("/");
  if (!EDITABLE.has(normalized)) return null;
  return resolve(__dirname, normalized);
}

// Log full error detail server-side; return a sanitized message to the client.
// 5xx responses never echo internals (paths, stack); 4xx pass the domain
// validation message through since those are developer-defined, not exceptions.
// Parse a query-string limit into a sane integer within [1, max].
function clampLimit(raw, fallback, max) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

function fail(res, status, err, clientMsg) {
  console.error(`[server] ${status}:`, err?.stack || err?.message || err);
  const body = clientMsg ?? (status < 500 ? String(err?.message || err) : "internal error");
  res.status(status).json({ error: body });
}

const app = express();
// Capture the raw body buffer alongside the parsed JSON. Slack signature
// verification needs the exact bytes Slack signed, before any parser
// touches them.
app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  }),
);
app.use(express.static(resolve(__dirname, "public")));

// Opt-in auth on the API surface. Off by default (safe because HOST is
// loopback); when COS_API_TOKEN is set it gates every /api route except the
// webhooks below, which carry their own verification (Slack signature,
// forward secret) and are called by services that cannot send the UI token.
const AUTH_EXEMPT = new Set(["/slack/event", "/forward"]);
app.use("/api", (req, res, next) => {
  if (!API_TOKEN) return next();
  if (AUTH_EXEMPT.has(req.path)) return next();
  const bearer = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const provided = req.get("x-cos-token") || bearer || req.query.token || "";
  if (constantTimeEqual(provided, API_TOKEN)) return next();
  return res.status(401).json({ error: "unauthorized" });
});

// Read all context + memory files at once.
app.get("/api/context", async (_req, res) => {
  const out = {};
  for (const path of EDITABLE) {
    try {
      out[path] = await readFile(resolve(__dirname, path), "utf8");
    } catch {
      out[path] = "";
    }
  }
  res.json(out);
});

// Read a single file by relative path.
app.get("/api/file", async (req, res) => {
  const abs = safePath(req.query.path);
  if (!abs) return res.status(400).json({ error: "path not allowed" });
  try {
    const content = await readFile(abs, "utf8");
    res.json({ path: req.query.path, content, readonly: READONLY.has(req.query.path) });
  } catch (err) {
    fail(res, 404, err, "not found");
  }
});

// Write a single file by relative path.
app.put("/api/file", async (req, res) => {
  const { path, content } = req.body || {};
  if (READONLY.has(path)) return res.status(403).json({ error: "read-only" });
  const abs = safePath(path);
  if (!abs) return res.status(400).json({ error: "path not allowed" });
  if (typeof content !== "string") return res.status(400).json({ error: "content required" });
  try {
    await writeFile(abs, content, "utf8");
    res.json({ ok: true, path });
  } catch (err) {
    fail(res, 500, err);
  }
});

// Maintenance audit: stale files, stubs, suggestions.
app.get("/api/maintenance", async (_req, res) => {
  const items = [];
  const now = Date.now();

  for (const path of EDITABLE) {
    if (path === "tasks.md" || path === "USAGE.md" || path === "CLAUDE.md") continue;
    let content = "";
    try {
      content = await readFile(resolve(__dirname, path), "utf8");
    } catch {
      continue;
    }

    const stubMatches = content.match(/_To fill in[^_]*_/g) || [];
    const lastUpdatedMatch = content.match(/Last updated:\s*(\d{4}-\d{2}-\d{2})/);

    let staleDays = null;
    if (lastUpdatedMatch) {
      staleDays = Math.floor(
        (now - new Date(lastUpdatedMatch[1]).getTime()) / 86400000,
      );
    }

    let fileMtime = null;
    try {
      const s = await stat(resolve(__dirname, path));
      fileMtime = s.mtimeMs;
    } catch {}

    // Stale rule: header says it has not been updated in > 14 days
    if (staleDays !== null && staleDays > 14) {
      items.push({
        kind: "stale",
        path,
        message: `Header date is ${staleDays} days old. Touch it during /retro.`,
        severity: "med",
      });
    }

    // Stub rule: file still has placeholder text
    if (stubMatches.length > 0) {
      items.push({
        kind: "stub",
        path,
        message: `${stubMatches.length} placeholder field${stubMatches.length === 1 ? "" : "s"} still says _To fill in_. Edit and replace.`,
        severity: stubMatches.length > 5 ? "high" : "med",
      });
    }

    // Specific recurring-cadence rules
    if (path === "memory/relationships.md") {
      const cleaned = content.replace(/```[\s\S]*?```/g, "");
      const ageDaysFromMtime =
        fileMtime ? Math.floor((now - fileMtime) / 86400000) : 999;
      const hasRealEntries = /^## .+/m.test(cleaned);
      if (!hasRealEntries) {
        items.push({
          kind: "empty",
          path,
          message:
            "No relationship entries yet. Backfill the highest-leverage 3 to 5 people before the next /prep.",
          severity: "high",
        });
      } else if (ageDaysFromMtime > 7) {
        items.push({
          kind: "stale",
          path,
          message: `Last edit ${ageDaysFromMtime} days ago. Add a line for the most recent meeting.`,
          severity: "med",
        });
      }
    }

    if (path === "memory/decisions.md") {
      const hasEntries = /^## \d{4}-\d{2}-\d{2}/m.test(content);
      if (!hasEntries) {
        items.push({
          kind: "empty",
          path,
          message:
            "No decisions logged yet. Use /commit after the next real call.",
          severity: "low",
        });
      }
    }

    if (path === "context/career_thesis.md") {
      if (/_To fill in.*obviously wrong/i.test(content) || /What "obviously wrong" looks like[\s\S]{0,300}_To fill in_/i.test(content)) {
        items.push({
          kind: "missing",
          path,
          message: "Name the offer you should refuse in May. Highest-leverage line in the thesis.",
          severity: "high",
        });
      }
    }
  }

  // Queue: overdue items.
  try {
    for (const item of queryOverdue()) {
      items.push({
        kind: "overdue",
        path: `queue:${item.id}`,
        message: `Overdue (${item.due_date}): ${item.summary}. Close, defer, or extend.`,
        severity: "high",
      });
    }
  } catch {}

  // Projects: status.md staleness and decisions.md emptiness.
  try {
    const projectsDir = resolve(__dirname, "projects");
    const entries = await readdir(projectsDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith("_")) continue;
      const slug = e.name;
      const statusPath = resolve(projectsDir, slug, "status.md");
      const statusRaw = await readFile(statusPath, "utf8").catch(() => null);
      if (statusRaw === null) {
        items.push({
          kind: "missing",
          path: `projects/${slug}/status.md`,
          message: `Project ${slug} has no status.md. Add one or archive the project.`,
          severity: "med",
        });
        continue;
      }
      const m = statusRaw.match(/Last updated:\s*(\d{4}-\d{2}-\d{2})/);
      if (m) {
        const age = Math.floor((now - new Date(m[1]).getTime()) / 86400000);
        if (age > 21) {
          items.push({
            kind: "stale",
            path: `projects/${slug}/status.md`,
            message: `Project ${slug} status has not been touched in ${age} days. Refresh or archive.`,
            severity: age > 45 ? "high" : "med",
          });
        }
      }
      // Project with no decisions logged in 30+ days
      const decRaw = await readFile(resolve(projectsDir, slug, "decisions.md"), "utf8").catch(() => "");
      const dateMatches = Array.from(decRaw.matchAll(/^##\s+(\d{4}-\d{2}-\d{2})/gm)).map((m) => m[1]);
      if (dateMatches.length === 0) {
        items.push({
          kind: "empty",
          path: `projects/${slug}/decisions.md`,
          message: `Project ${slug} has no decisions logged. Use /commit ${slug}: ... after the next real call.`,
          severity: "low",
        });
      } else {
        const newest = dateMatches.sort().slice(-1)[0];
        const age = Math.floor((now - new Date(newest).getTime()) / 86400000);
        if (age > 30) {
          items.push({
            kind: "stale",
            path: `projects/${slug}/decisions.md`,
            message: `Project ${slug}: no decisions logged in ${age} days. Stalled, or finishing quietly?`,
            severity: "med",
          });
        }
      }
    }
  } catch {}

  // Sort: high -> med -> low, then by path
  const order = { high: 0, med: 1, low: 2 };
  items.sort((a, b) => order[a.severity] - order[b.severity] || a.path.localeCompare(b.path));

  res.json({ items });
});

// --- Queue ---------------------------------------------------------------
// Read-only and write endpoints over the JSONL-backed work queue.

app.get("/api/queue", (req, res) => {
  try {
    const { bucket, project, direction, overdue, all } = req.query;
    let items;
    if (overdue === "1" || overdue === "true") items = queryOverdue();
    else if (project) items = queryByProject(project);
    else if (bucket) items = queryByBucket(bucket);
    else if (direction) items = queryByDirection(direction);
    else if (all === "1" || all === "true") items = Array.from(loadQueue().values());
    else items = loadOpen();
    res.json({ items });
  } catch (err) {
    fail(res, 500, err);
  }
});

app.get("/api/queue/:id", (req, res) => {
  const item = getQueueItem(req.params.id);
  if (!item) return res.status(404).json({ error: `item ${req.params.id} not found` });
  res.json({ item });
});

app.post("/api/queue", (req, res) => {
  try {
    const { partial = {}, actor = "ui", rule = null } = req.body || {};
    const item = qAdd(partial, { actor, rule });
    res.json({ item });
  } catch (err) {
    fail(res, 400, err);
  }
});

app.patch("/api/queue/:id", (req, res) => {
  try {
    const { patch = {}, actor = "ui", rule = null, action = "updated" } = req.body || {};
    const item = qUpdate(req.params.id, patch, { actor, rule, action });
    res.json({ item });
  } catch (err) {
    fail(res, 400, err);
  }
});

app.post("/api/queue/:id/close", (req, res) => {
  try {
    const { outcome = "done", actor = "ui", rule = null, approval_state } = req.body || {};
    const item = qClose(req.params.id, outcome, { actor, rule, approval_state });
    res.json({ item });
  } catch (err) {
    fail(res, 400, err);
  }
});

app.post("/api/queue/:id/undo", (req, res) => {
  try {
    const { actor = "ui", rule = null } = req.body || {};
    const item = qUndo(req.params.id, { actor, rule });
    res.json({ item });
  } catch (err) {
    fail(res, 400, err);
  }
});

app.get("/api/queue/:id/history", (req, res) => {
  try {
    const snapshots = qHistory(req.params.id);
    if (!snapshots.length) return res.status(404).json({ error: `no history for ${req.params.id}` });
    res.json({
      id: req.params.id,
      snapshots: snapshots.map((s) => ({
        updated_at: s.updated_at,
        status: s.status,
        approval_state: s.approval_state,
        bucket: s.bucket,
        assigned_to: s.assigned_to ?? null,
        last_action: (s.audit ?? []).slice(-1)[0]?.action ?? null,
        last_actor: (s.audit ?? []).slice(-1)[0]?.actor ?? null,
      })),
    });
  } catch (err) {
    fail(res, 500, err);
  }
});

// --- Conformance observability ------------------------------------------
// Read the conform-audit JSONL and return summary stats + recent entries.
// Drives the dashboard's "voice-rule drift" panel.

app.get("/api/conform/audit", async (req, res) => {
  const limit = clampLimit(req.query.limit, 200, 2000);
  const auditPath = resolve(__dirname, "data", "conform-audit.jsonl");
  try {
    const raw = await readFile(auditPath, "utf8").catch(() => "");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const entries = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const tail = entries.slice(-limit);

    // Summary stats.
    const counts = {};
    let passes = 0;
    let fails = 0;
    let totalViolations = 0;
    for (const e of tail) {
      if (e.ok) passes++; else fails++;
      totalViolations += e.violation_count ?? 0;
      for (const r of e.violation_rules ?? []) counts[r] = (counts[r] ?? 0) + 1;
    }
    const topRules = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([rule, count]) => ({ rule, count }));
    const passRate = (passes + fails) > 0 ? passes / (passes + fails) : null;

    res.json({
      total: tail.length,
      passes,
      fails,
      passRate,
      totalViolations,
      topRules,
      entries: tail,
    });
  } catch (err) {
    fail(res, 500, err);
  }
});

// --- Forwarding-address inbound channel (Town pattern) -------------------
// Accepts a JSON payload representing a forwarded email and writes it as a
// Yellow queue item. Wire a Gmail filter or Cloudflare Email Routing to POST
// here from a dedicated address (e.g. cos@<your-domain>). The request must
// carry X-Forward-Secret matching FORWARD_SECRET in .env (if set).
//
// Subject conventions parsed:
//   [project-slug] in subject  -> sets the queue item's project field
//   !urgent or !high           -> priority high
//   !low                       -> priority low
//   default                    -> priority med, bucket Prep
//
// Expected payload shape:
//   {
//     from: "Daniel <daniel@example.com>",
//     subject: "[anthropic-pm-interview] !high re: timing",
//     body: "...",
//     message_id: "<...>",
//     received_at: "2026-05-20T07:32:00Z"
//   }
app.post("/api/forward", (req, res) => {
  const secret = process.env.FORWARD_SECRET;
  if (secret) {
    const provided = req.headers["x-forward-secret"];
    if (!constantTimeEqual(provided, secret)) return res.status(401).json({ error: "unauthorized" });
  }

  const { from, subject, body, message_id, received_at } = req.body || {};
  if (!subject && !body) return res.status(400).json({ error: "subject or body required" });

  let project = null;
  let priority = "med";
  let cleanSubject = subject || "";

  const projMatch = cleanSubject.match(/\[([a-z0-9][a-z0-9-]*)\]/i);
  if (projMatch) {
    project = projMatch[1].toLowerCase();
    cleanSubject = cleanSubject.replace(projMatch[0], "").trim();
  }

  if (/!\s*(urgent|high)\b/i.test(cleanSubject)) {
    priority = "high";
    cleanSubject = cleanSubject.replace(/!\s*(urgent|high)\b/gi, "").trim();
  } else if (/!\s*low\b/i.test(cleanSubject)) {
    priority = "low";
    cleanSubject = cleanSubject.replace(/!\s*low\b/gi, "").trim();
  }

  const provenance = [
    {
      type: "gmail.forward",
      ref: message_id ?? `forward-${Date.now()}`,
      captured_at: received_at ?? new Date().toISOString(),
    },
  ];
  if (from) provenance.push({ type: "sender", ref: from });

  try {
    const item = qAdd(
      {
        bucket: "Prep",
        priority,
        project,
        summary: cleanSubject || "(forwarded email)",
        source: "forward",
        source_id: message_id ?? null,
        sender: from ?? null,
        subject,
        proposed_action: `Forwarded email. Body preview:\n${(body ?? "").slice(0, 400)}`,
        provenance,
        required_tier: 0,
      },
      { actor: "forward-endpoint", rule: "forward.received" },
    );
    res.json({ ok: true, item });
  } catch (err) {
    fail(res, 400, err);
  }
});

// --- Slack thread-native surface (Town pattern) --------------------------
// Receives Slack Events API payloads. Handles URL verification, app mentions
// (writes a Yellow queue item with the thread metadata for follow-up), and
// thread replies of the form "/approve <queue-id>" or "/close <queue-id>"
// that close the loop on the queue item.
//
// Setup: see SLACK_SETUP.md. The endpoint expects a Slack signing secret
// in SLACK_SIGNING_SECRET (optional; if set, every request's signature is
// verified). Outbound replies use tools/slack-respond.mjs.

import crypto from "node:crypto";

// Length-safe, constant-time string compare for secrets/tokens.
function constantTimeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ""));
  const bb = Buffer.from(String(b ?? ""));
  if (ab.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

function verifySlackSignature(req, rawBody) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) return true; // Soft mode for local dev.
  const ts = req.headers["x-slack-request-timestamp"];
  const sig = req.headers["x-slack-signature"];
  if (!ts || !sig) return false;
  // Reject replays older than 5 minutes.
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const base = `v0:${ts}:${rawBody}`;
  const computed = "v0=" + crypto.createHmac("sha256", signingSecret).update(base).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(sig));
  } catch {
    return false;
  }
}

// Slack endpoint. The global JSON parser captured the raw body via the
// `verify` hook, so we can verify signatures against the exact bytes Slack
// signed while still using req.body for the parsed payload.
async function draftSlackReply({ channel, threadTs, userText, kind }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return;
  const prompt = `Source: ${kind}\nUser message: ${userText || "(empty)"}`;
  let ctx;
  try {
    ctx = loadSlackContext();
  } catch (err) {
    console.error("[slack reply] context load failed, falling back to base prompt only:", err.message);
    ctx = { context: "", fingerprint: "none", sections: {} };
  }
  const system = ctx.context
    ? [
        { type: "text", text: SLACK_REPLY_SYSTEM_BASE },
        { type: "text", text: ctx.context, cache_control: { type: "ephemeral" } },
      ]
    : [{ type: "text", text: SLACK_REPLY_SYSTEM_BASE }];
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 500,
        system,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error("[slack reply] anthropic error", r.status, JSON.stringify(data).slice(0, 200));
      return;
    }
    const text = data?.content?.[0]?.text;
    if (!text) {
      console.error("[slack reply] empty response");
      return;
    }
    await postSlack({ channel, thread: threadTs, text });
    const u = data?.usage ?? {};
    const cacheTag = u.cache_read_input_tokens > 0
      ? `cache-hit(${u.cache_read_input_tokens}tk)`
      : u.cache_creation_input_tokens > 0
        ? `cache-write(${u.cache_creation_input_tokens}tk)`
        : "no-cache";
    console.log(`[slack reply] sent ${text.length} chars to ${channel}${threadTs ? `:${threadTs}` : ""} ctx=${ctx.fingerprint} ${cacheTag}`);
  } catch (err) {
    console.error("[slack reply] failed:", err.message);
  }
}

app.post("/api/slack/event", (req, res) => {
  if (!verifySlackSignature(req, req.rawBody ?? "")) {
    console.log("[slack event] bad signature");
    return res.status(401).json({ error: "bad signature" });
  }
  const payload = req.body || {};

  // URL verification handshake on app install.
  if (payload.type === "url_verification") {
    console.log("[slack event] url_verification challenge");
    return res.status(200).type("text/plain").send(payload.challenge);
  }

  if (payload.type !== "event_callback" || !payload.event) {
    console.log(`[slack event] non-event_callback: ${payload.type}`);
    return res.status(200).json({ ok: true });
  }

  const event = payload.event;
  console.log(`[slack event] type=${event.type} channel_type=${event.channel_type ?? "-"} channel=${event.channel ?? "-"} bot=${!!event.bot_id} text=${(event.text || "").slice(0, 80)}`);

    // /approve <queue-id> or /close <queue-id> in a thread reply.
    if (event.type === "message" && typeof event.text === "string" && !event.bot_id) {
      const approveMatch = event.text.match(/\/approve\s+(q_\S+)/);
      const closeMatch = event.text.match(/\/close\s+(q_\S+)/);
      if (approveMatch) {
        try {
          const item = qUpdate(
            approveMatch[1],
            { approval_state: "approved" },
            { actor: "slack", rule: "slack.approve", action: "approved" },
          );
          return res.status(200).json({ ok: true, item: item.id });
        } catch (err) {
          return fail(res, 400, err);
        }
      }
      if (closeMatch) {
        try {
          const item = qClose(closeMatch[1], "closed via slack", {
            actor: "slack",
            rule: "slack.close",
          });
          return res.status(200).json({ ok: true, item: item.id });
        } catch (err) {
          return fail(res, 400, err);
        }
      }
    }

    // app_mention: someone @-mentioned the bot. Create a Yellow queue item
    // capturing the thread context AND fire a real-time reply in-thread.
    if (event.type === "app_mention") {
      try {
        const channel = event.channel;
        const threadTs = event.thread_ts ?? event.ts;
        const item = qAdd(
          {
            bucket: "Prep",
            priority: "med",
            summary: `Slack mention in ${channel}: ${(event.text || "").slice(0, 120)}`,
            source: "slack",
            source_id: `${channel}:${threadTs}`,
            sender: event.user ?? null,
            proposed_action: `Read the thread, draft a reply, post via tools/slack-respond.mjs with thread_ts=${threadTs}.`,
            provenance: [
              {
                type: "slack.mention",
                ref: `${channel}:${threadTs}`,
                note: event.text ?? null,
              },
            ],
            required_tier: 0,
          },
          { actor: "slack-endpoint", rule: "slack.mention" },
        );
        res.status(200).json({ ok: true, item: item.id });
        // Fire-and-forget real-time reply so Slack's 3s ack budget is met.
        draftSlackReply({
          channel,
          threadTs,
          userText: event.text,
          kind: "channel mention",
        }).catch((err) => console.error("[slack reply] dispatch error:", err.message));
        return;
      } catch (err) {
        return fail(res, 500, err);
      }
    }

    // Plain DM to the bot (no /approve or /close above). Fire a real-time
    // reply but do not create a queue item: DMs are conversation, mentions
    // are work items.
    if (event.type === "message" && event.channel_type === "im" && !event.bot_id && typeof event.text === "string") {
      res.status(200).json({ ok: true });
      draftSlackReply({
        channel: event.channel,
        threadTs: null,
        userText: event.text,
        kind: "DM",
      }).catch((err) => console.error("[slack reply] dispatch error:", err.message));
      return;
    }

    return res.status(200).json({ ok: true });
  },
);

// --- Tiers and permit audit ----------------------------------------------

app.get("/api/tiers", (_req, res) => {
  try {
    res.json(loadTiers());
  } catch (err) {
    fail(res, 500, err);
  }
});

app.post("/api/permit/check", (req, res) => {
  try {
    const { action, actor, itemId, note } = req.body || {};
    if (!action || !actor) return res.status(400).json({ error: "action and actor required" });
    res.json(permitCheck({ action, actor, itemId, note }));
  } catch (err) {
    fail(res, 500, err);
  }
});

app.post("/api/permit/raise", (req, res) => {
  try {
    const { actor, tier, reason } = req.body || {};
    if (!actor || tier === undefined) return res.status(400).json({ error: "actor and tier required" });
    res.json(raiseActor(actor, Number(tier), { reason, actorWriter: "user" }));
  } catch (err) {
    fail(res, 400, err);
  }
});

app.get("/api/permit/audit", async (req, res) => {
  const limit = clampLimit(req.query.limit, 100, 2000);
  const auditPath = resolve(__dirname, "data", "permit-audit.jsonl");
  try {
    const raw = await readFile(auditPath, "utf8").catch(() => "");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const tail = lines.slice(-limit).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    res.json({ entries: tail });
  } catch (err) {
    fail(res, 500, err);
  }
});

// --- Projects ------------------------------------------------------------

const PROJECT_FILES = new Set(["status.md", "decisions.md", "commitments.md", "notes.md"]);

function safeSlug(slug) {
  if (typeof slug !== "string") return null;
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) return null;
  return slug;
}

app.get("/api/projects", async (_req, res) => {
  const projectsDir = resolve(__dirname, "projects");
  try {
    const entries = await readdir(projectsDir, { withFileTypes: true });
    const projects = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith("_")) continue;
      const status = await readFile(resolve(projectsDir, e.name, "status.md"), "utf8").catch(() => "");
      const updatedMatch = status.match(/Last updated:\s*(\d{4}-\d{2}-\d{2})/);
      const confMatch = status.match(/Confidence:\*\*\s*([HMLhml])/);
      projects.push({
        slug: e.name,
        last_updated: updatedMatch ? updatedMatch[1] : null,
        confidence: confMatch ? confMatch[1].toUpperCase() : null,
      });
    }
    res.json({ projects });
  } catch (err) {
    fail(res, 500, err);
  }
});

app.get("/api/projects/:slug", async (req, res) => {
  const slug = safeSlug(req.params.slug);
  if (!slug) return res.status(400).json({ error: "bad slug" });
  const projectsDir = resolve(__dirname, "projects", slug);
  try {
    const files = {};
    for (const name of PROJECT_FILES) {
      files[name] = await readFile(resolve(projectsDir, name), "utf8").catch(() => "");
    }
    res.json({ slug, files });
  } catch (err) {
    fail(res, 500, err);
  }
});

app.put("/api/projects/:slug/:file", async (req, res) => {
  const slug = safeSlug(req.params.slug);
  if (!slug) return res.status(400).json({ error: "bad slug" });
  if (!PROJECT_FILES.has(req.params.file)) return res.status(400).json({ error: "unknown project file" });
  const { content } = req.body || {};
  if (typeof content !== "string") return res.status(400).json({ error: "content required" });
  try {
    await writeFile(resolve(__dirname, "projects", slug, req.params.file), content, "utf8");
    res.json({ ok: true, slug, file: req.params.file });
  } catch (err) {
    fail(res, 500, err);
  }
});

// Streaming chat endpoint.
app.post("/api/chat", async (req, res) => {
  const prompt = (req.body?.prompt || "").trim();
  if (!prompt) return res.status(400).json({ error: "prompt required" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  if (DEMO_MODE) {
    send("text", { text: "Demo mode: chat disabled. The queue, projects, and audit panels render real data so you can see the substrate populated. Set ANTHROPIC_API_KEY in .env and restart to enable the agent." });
    send("result", { cost_usd: 0, duration_ms: 0, num_turns: 0 });
    res.write("event: done\ndata: {}\n\n");
    return res.end();
  }

  try {
    for await (const message of query({
      prompt,
      options: {
        cwd: __dirname,
        systemPrompt: { type: "preset", preset: "claude_code", append: systemPrompt },
        permissionMode: "acceptEdits",
        settingSources: ["user", "project", "local"],
      },
    })) {
      switch (message.type) {
        case "assistant":
          for (const block of message.message.content) {
            if (block.type === "text") send("text", { text: block.text });
            else if (block.type === "tool_use") send("tool", { name: block.name });
          }
          break;
        case "result":
          send("result", {
            cost_usd: message.total_cost_usd ?? 0,
            duration_ms: message.duration_ms ?? 0,
            num_turns: message.num_turns ?? 0,
          });
          break;
      }
    }
  } catch (err) {
    send("error", { message: String(err?.message || err) });
  } finally {
    res.write("event: done\ndata: {}\n\n");
    res.end();
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Chief of Staff UI running at http://${HOST}:${PORT}`);
  const loopback = HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1";
  if (!loopback && !API_TOKEN) {
    console.warn(
      `WARNING: bound to ${HOST} (non-loopback) with no COS_API_TOKEN set. ` +
        `Every /api route, including the agent chat at /api/chat, is reachable ` +
        `unauthenticated. Set COS_API_TOKEN or bind to 127.0.0.1.`,
    );
  }
});
