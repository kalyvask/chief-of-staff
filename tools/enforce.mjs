#!/usr/bin/env node
// Chief of Staff: tool-use enforcement.
//
// Turns the permit engine from contract into mechanism for the chat agent.
// Until now, permit() gated only what a command chose to check via permit-cli;
// nothing stopped a confused (or prompt-injected) agent from calling an MCP
// write tool directly. This module is the canUseTool hook for the Agent SDK:
// every side-effect MCP tool call must be preceded by a fresh allowed permit
// check, or it is denied at the tool layer with instructions on how to do it
// right.
//
// The rule:
//   - Read tools (list/get/search/query/read) on any server: allowed.
//   - Write tools on gcal/gmail: allowed only if data/permit-audit.jsonl has an
//     allowed=true entry for a matching action class within the last 10
//     minutes. The agent earns that entry by running
//     `node tools/permit-cli.mjs check --action <class> --actor <name> [--item <id>]`
//     first -- which is exactly what the command prompts already instruct.
//   - Write-looking tools on gcal/gmail with no mapped action class: denied.
//   - Tools on unknown MCP servers and all built-in tools: allowed (out of
//     scope here; built-ins are governed by the SDK permission mode).
//
// Public API:
//   classifyTool(toolName)                        -> {server, kind, actions} | null
//   decideToolUse(toolName, auditEntries, nowMs)  -> {behavior, message?}
//   makeCanUseTool()                              -> SDK canUseTool callback
//
// CLI:
//   node tools/enforce.mjs classify mcp__gcal__delete_event
//   node tools/enforce.mjs decide mcp__gcal__delete_event
//   node tools/enforce.mjs self-test

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const AUDIT_PATH = path.resolve(REPO_ROOT, 'data', 'permit-audit.jsonl');

// A permit allow is "fresh" for this long. Long enough for the check -> tool
// call sequence inside one command run; short enough that a stale allow from
// this morning does not authorize an unrelated call this afternoon.
const ALLOW_WINDOW_MS = 10 * 60 * 1000;

// MCP servers under enforcement. Everything else passes through untouched.
const ENFORCED_SERVERS = new Set(['gcal', 'gmail']);

// Write tools -> the permit action classes that satisfy them. A recent allow
// on ANY listed class passes (e.g. create_event covers both a real event and
// a focus block; respond_to_event covers a gated decline or spam-decline).
const WRITE_ACTIONS = {
  'gcal:create_event': ['calendar.create-event', 'calendar.create-focus-block'],
  'gcal:update_event': ['calendar.reschedule', 'calendar.cancel'],
  'gcal:delete_event': ['calendar.cancel'],
  'gcal:respond_to_event': ['calendar.cancel', 'calendar.decline-spam'],
  'gmail:send_email': ['email.send-external', 'email.send-ack', 'email.send-self'],
  'gmail:modify_email': ['email.label', 'email.archive'],
  'gmail:batch_modify_emails': ['email.label', 'email.archive'],
  'gmail:label_email': ['email.label'],
  'gmail:archive_email': ['email.archive'],
};

// Name prefixes that mark a tool as read-only.
const READ_PREFIXES = ['list_', 'get_', 'search_', 'query_', 'read_', 'fetch_', 'suggest_'];

export function classifyTool(toolName) {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(String(toolName || ''));
  if (!m) return null; // built-in tool
  const [, server, tool] = m;
  if (!ENFORCED_SERVERS.has(server)) return { server, tool, kind: 'unenforced', actions: null };
  if (READ_PREFIXES.some((p) => tool.startsWith(p))) return { server, tool, kind: 'read', actions: null };
  const actions = WRITE_ACTIONS[`${server}:${tool}`];
  if (actions) return { server, tool, kind: 'write', actions };
  // Write-looking tool on an enforced server with no mapping: fail closed.
  return { server, tool, kind: 'unmapped-write', actions: null };
}

function readAuditTail(maxLines = 400) {
  let raw = '';
  try { raw = fs.readFileSync(AUDIT_PATH, 'utf8'); } catch { return []; }
  const lines = raw.split('\n').filter(Boolean).slice(-maxLines);
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch { /* skip bad line */ }
  }
  return out;
}

export function hasRecentAllow(actions, auditEntries, nowMs, windowMs = ALLOW_WINDOW_MS) {
  const wanted = new Set(actions);
  for (let i = auditEntries.length - 1; i >= 0; i--) {
    const e = auditEntries[i];
    if (!e || e.allowed !== true || !wanted.has(e.action)) continue;
    const t = Date.parse(e.at);
    if (!Number.isNaN(t) && nowMs - t <= windowMs) return e;
  }
  return null;
}

/**
 * Pure decision: should this tool call proceed?
 */
export function decideToolUse(toolName, auditEntries = [], nowMs = Date.now()) {
  const cls = classifyTool(toolName);
  if (!cls) return { behavior: 'allow' };                      // built-in
  if (cls.kind === 'unenforced') return { behavior: 'allow' }; // other MCP server
  if (cls.kind === 'read') return { behavior: 'allow' };
  if (cls.kind === 'unmapped-write') {
    return {
      behavior: 'deny',
      message: `${toolName} is a write tool with no permit action class. It is not allowed from the agent. If this tool should exist, map it in tools/enforce.mjs WRITE_ACTIONS first.`,
    };
  }
  const allow = hasRecentAllow(cls.actions, auditEntries, nowMs);
  if (allow) return { behavior: 'allow', permit: allow };
  return {
    behavior: 'deny',
    message: `${toolName} requires a fresh permit. Run \`node tools/permit-cli.mjs check --action ${cls.actions[0]} --actor <your-actor> --item <queue-id>\` first; it must return allowed:true (the item needs approval_state=approved and the actor tier raised by the user). Then retry the tool call within 10 minutes.`,
  };
}

/**
 * The SDK callback. Reads the live audit file on each side-effect call.
 */
export function makeCanUseTool() {
  return async (toolName, input) => {
    const decision = decideToolUse(toolName, readAuditTail(), Date.now());
    if (decision.behavior === 'allow') return { behavior: 'allow', updatedInput: input };
    return { behavior: 'deny', message: decision.message };
  };
}

// ---------------------------------------------------------------- self-test
function selfTest() {
  const cases = [];
  const ok = (name, cond) => cases.push({ name, pass: !!cond });
  const now = Date.parse('2026-06-09T12:00:00Z');
  const fresh = { at: '2026-06-09T11:55:00Z', action: 'calendar.cancel', allowed: true };
  const stale = { at: '2026-06-09T09:00:00Z', action: 'calendar.cancel', allowed: true };
  const denied = { at: '2026-06-09T11:59:00Z', action: 'calendar.cancel', allowed: false };

  ok('built-in tool -> allow', decideToolUse('Bash', [], now).behavior === 'allow');
  ok('built-in Read -> allow', decideToolUse('Read', [], now).behavior === 'allow');
  ok('unknown MCP server -> allow', decideToolUse('mcp__composio__do_thing', [], now).behavior === 'allow');
  ok('gcal read -> allow', decideToolUse('mcp__gcal__list_events', [], now).behavior === 'allow');
  ok('gcal suggest_time -> allow', decideToolUse('mcp__gcal__suggest_time', [], now).behavior === 'allow');
  ok('gmail search -> allow', decideToolUse('mcp__gmail__search_emails', [], now).behavior === 'allow');

  ok('delete_event w/o permit -> deny', decideToolUse('mcp__gcal__delete_event', [], now).behavior === 'deny');
  ok('delete_event deny names the action', decideToolUse('mcp__gcal__delete_event', [], now).message.includes('calendar.cancel'));
  ok('delete_event with fresh allow -> allow', decideToolUse('mcp__gcal__delete_event', [fresh], now).behavior === 'allow');
  ok('delete_event with stale allow -> deny', decideToolUse('mcp__gcal__delete_event', [stale], now).behavior === 'deny');
  ok('delete_event with denied entry -> deny', decideToolUse('mcp__gcal__delete_event', [denied], now).behavior === 'deny');
  ok('wrong action class does not satisfy', decideToolUse('mcp__gmail__send_email', [fresh], now).behavior === 'deny');

  const focusAllow = { at: '2026-06-09T11:58:00Z', action: 'calendar.create-focus-block', allowed: true };
  ok('create_event satisfied by focus-block allow', decideToolUse('mcp__gcal__create_event', [focusAllow], now).behavior === 'allow');

  const sendSelf = { at: '2026-06-09T11:58:00Z', action: 'email.send-self', allowed: true };
  ok('send_email satisfied by send-self allow', decideToolUse('mcp__gmail__send_email', [sendSelf], now).behavior === 'allow');

  ok('unmapped write on enforced server -> deny', decideToolUse('mcp__gmail__delete_email', [fresh], now).behavior === 'deny');
  ok('classify built-in -> null', classifyTool('Bash') === null);
  ok('classify read kind', classifyTool('mcp__gcal__get_event').kind === 'read');
  ok('classify write kind + actions', classifyTool('mcp__gcal__delete_event').actions.includes('calendar.cancel'));
  ok('hasRecentAllow picks newest matching', !!hasRecentAllow(['calendar.cancel'], [stale, fresh], now));

  const failed = cases.filter((c) => !c.pass);
  for (const c of cases) process.stdout.write(`${c.pass ? 'ok  ' : 'FAIL'} ${c.name}\n`);
  process.stdout.write(`\n${cases.length - failed.length}/${cases.length} passed\n`);
  process.exit(failed.length ? 1 : 0);
}

// ---------------------------------------------------------------------- CLI
const cmd = process.argv[2];
const arg = process.argv[3];

switch (cmd) {
  case 'classify':
    process.stdout.write(`${JSON.stringify(classifyTool(arg), null, 2)}\n`);
    break;
  case 'decide':
    process.stdout.write(`${JSON.stringify(decideToolUse(arg, readAuditTail(), Date.now()), null, 2)}\n`);
    break;
  case 'self-test':
    selfTest();
    break;
  default:
    process.stdout.write('usage: node tools/enforce.mjs <classify|decide|self-test> [toolName]\n');
    process.exit(cmd ? 2 : 0);
}
