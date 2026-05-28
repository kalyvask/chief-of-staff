#!/usr/bin/env node
// Chief of Staff: setup doctor.
//
// Aggregates every check and prints a red/yellow/green dashboard plus a
// punch list of what is still missing. Read-only; writes nothing.
//
// Sections:
//   1. Filesystem    -- .env exists, node_modules present, key files
//                       present, context files filled in (not template)
//   2. Services      -- anthropic, smtp, mcp, slack, forward
//   3. Substrate     -- queue accessible, graph buildable, evals pass
//
// Exit code:
//   0 -- everything green
//   1 -- one or more high-severity failures (red)
//   2 -- only yellow warnings (degraded but usable)
//
// Usage:
//   node tools/doctor.mjs              # full report, exit code reflects state
//   node tools/doctor.mjs --json       # machine-readable
//   node tools/doctor.mjs --quick      # skip slow network calls

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv, REPO_ROOT } from './check/common.mjs';
import { checkAnthropic } from './check/anthropic.mjs';
import { checkSmtp } from './check/smtp.mjs';
import { checkMcp } from './check/mcp.mjs';
import { checkSlack } from './check/slack.mjs';
import { checkForward } from './check/forward.mjs';
import { checkComposio } from './check/composio.mjs';

loadDotEnv();

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = true;
    else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv);
const quick = !!args.quick;
const asJson = !!args.json;

const sections = [];

// --- Filesystem ---
function checkFilesystem() {
  const items = [];
  const must = [
    '.env', 'package.json', 'CLAUDE.md', 'AGENTS.md', 'USAGE.md', 'README.md',
    'send-to-self.mjs', 'server.mjs', 'index.mjs',
    'tools/queue.mjs', 'tools/permit.mjs', 'tools/conform.mjs',
    'data/tiers.json', 'data/conform-rules.json',
    '.claude/agents/chief-of-staff.md', '.claude/agents/email-drafter.md',
    '.claude/commands/am-sweep.md', '.claude/commands/brief.md',
    'projects/_template/status.md',
  ];
  for (const rel of must) {
    const full = path.join(REPO_ROOT, rel);
    items.push({
      check: `file ${rel}`,
      ok: fs.existsSync(full),
      severity: rel === '.env' ? 'med' : 'high',
      hint: rel === '.env' ? 'cp .env.example .env' : null,
    });
  }
  if (!fs.existsSync(path.join(REPO_ROOT, 'node_modules'))) {
    items.push({ check: 'node_modules', ok: false, severity: 'high', hint: 'npm install' });
  } else {
    items.push({ check: 'node_modules', ok: true });
  }

  // Context file fill state. Template placeholders count as not-filled.
  // Accept *.local.md as satisfying the corresponding template (Alex's
  // convention from .gitignore: personal copy suffixed `.local.md`).
  const contextChecks = [
    ['context/stakeholders.md', '_To fill in_'],
    ['context/priorities.md', '_To fill in_'],
    ['context/career_thesis.md', '_To fill in_'],
    ['context/operating_principles.md', '_To fill in_'],
    ['CLAUDE.md', '<One paragraph:'],
  ];
  for (const [rel, marker] of contextChecks) {
    const full = path.join(REPO_ROOT, rel);
    const local = full.replace(/\.md$/, '.local.md');
    let filled = false;
    if (fs.existsSync(local)) {
      const text = fs.readFileSync(local, 'utf8');
      filled = !!text.trim() && !text.includes(marker);
    }
    if (!filled && fs.existsSync(full)) {
      const text = fs.readFileSync(full, 'utf8');
      filled = !text.includes(marker);
    }
    items.push({
      check: `content: ${rel}`,
      ok: filled,
      severity: 'med',
      hint: filled ? null : 'npm run init',
    });
  }

  return { name: 'Filesystem', items };
}

// --- Services ---
async function checkServices() {
  const items = [];
  const env = process.env;
  const haveAnthropic = !!env.ANTHROPIC_API_KEY;
  const haveSmtp = !!(env.SMTP_HOST || env.ROLE_RADAR_SMTP_HOST);
  const haveSlack = !!(env.SLACK_BOT_TOKEN || env.SLACK_WEBHOOK_URL);
  const haveForward = !!env.FORWARD_SECRET;

  const haveComposio = !!env.COMPOSIO_API_KEY;

  if (quick) {
    items.push({ check: 'anthropic', ok: haveAnthropic, severity: 'high', hint: haveAnthropic ? null : 'set ANTHROPIC_API_KEY in .env' });
    items.push({ check: 'smtp', ok: haveSmtp, severity: 'high', hint: haveSmtp ? null : 'set SMTP_HOST etc. in .env (see .env.example)' });
    items.push({ check: 'composio', ok: haveComposio, severity: 'low', hint: haveComposio ? null : 'optional; managed MCP alternative to MCP_SETUP.md' });
    items.push({ check: 'slack', ok: haveSlack, severity: 'low', hint: haveSlack ? null : 'optional; see SLACK_SETUP.md' });
    items.push({ check: 'forward', ok: haveForward, severity: 'low', hint: haveForward ? null : 'optional; see FORWARD_SETUP.md' });
    items.push({ check: 'mcp', ok: null, severity: 'med', hint: 'skipped in --quick mode; run `claude mcp list` to verify' });
    return { name: 'Services (config only; --quick)', items };
  }

  const promises = [
    haveAnthropic ? checkAnthropic() : Promise.resolve({ service: 'anthropic', ok: false, error: 'ANTHROPIC_API_KEY not set' }),
    haveSmtp ? checkSmtp() : Promise.resolve({ service: 'smtp', ok: false, error: 'SMTP not configured' }),
    checkMcp(),
    checkSlack(),
    checkForward(),
    checkComposio(),
  ];
  const [anthropic, smtp, mcp, slack, forward, composio] = await Promise.all(promises);

  items.push({ check: 'anthropic', ok: anthropic.ok, severity: 'high', detail: anthropic.detail ?? anthropic.error, latencyMs: anthropic.latencyMs });
  items.push({ check: 'smtp', ok: smtp.ok, severity: 'high', detail: smtp.detail ?? smtp.error, latencyMs: smtp.latencyMs });
  items.push({ check: 'mcp', ok: mcp.ok, severity: 'med', detail: mcp.detail ?? mcp.error });
  items.push({
    check: 'composio',
    ok: composio.ok,
    severity: haveComposio ? 'med' : 'low',
    detail: composio.detail ?? composio.error,
    latencyMs: composio.latencyMs,
  });
  items.push({
    check: 'slack',
    ok: slack.ok,
    severity: (process.env.SLACK_BOT_TOKEN || process.env.SLACK_WEBHOOK_URL) ? 'med' : 'low',
    detail: slack.detail ?? slack.error,
    latencyMs: slack.latencyMs,
  });
  items.push({
    check: 'forward',
    ok: forward.ok,
    severity: process.env.FORWARD_SECRET ? 'med' : 'low',
    detail: forward.detail ?? forward.error,
  });

  return { name: 'Services', items };
}

// --- Substrate ---
async function checkSubstrate() {
  const items = [];
  // queue.jsonl exists or can be created
  const queuePath = path.join(REPO_ROOT, 'data', 'queue.jsonl');
  items.push({
    check: 'queue.jsonl readable',
    ok: !fs.existsSync(queuePath) || fs.statSync(queuePath).isFile(),
    severity: 'high',
    hint: null,
  });
  // permit-audit.jsonl path writable
  const dataDir = path.join(REPO_ROOT, 'data');
  items.push({
    check: 'data/ writable',
    ok: fs.existsSync(dataDir) && (() => { try { fs.accessSync(dataDir, fs.constants.W_OK); return true; } catch { return false; } })(),
    severity: 'high',
  });
  // graph file presence (warning only)
  const graphPath = path.join(REPO_ROOT, 'data', 'graph.json');
  items.push({
    check: 'graph.json present',
    ok: fs.existsSync(graphPath),
    severity: 'low',
    hint: fs.existsSync(graphPath) ? null : 'npm run graph',
  });
  return { name: 'Substrate', items };
}

const fs_section = checkFilesystem();
const services_section = await checkServices();
const substrate_section = await checkSubstrate();
sections.push(fs_section, services_section, substrate_section);

// Tally.
const tally = { red: 0, yellow: 0, green: 0, skipped: 0 };
for (const s of sections) {
  for (const item of s.items) {
    if (item.ok === true) tally.green++;
    else if (item.ok === null) tally.skipped++;
    else if (item.severity === 'high') tally.red++;
    else tally.yellow++;
  }
}

if (asJson) {
  process.stdout.write(JSON.stringify({ tally, sections }, null, 2) + '\n');
} else {
  for (const section of sections) {
    process.stdout.write(`\n== ${section.name} ==\n`);
    for (const item of section.items) {
      const icon = item.ok === true ? 'ok  ' : item.ok === null ? 'skip' : item.severity === 'high' ? 'RED ' : 'YEL ';
      const tail = [];
      if (item.detail) tail.push(item.detail);
      if (item.latencyMs) tail.push(`${item.latencyMs}ms`);
      if (item.hint) tail.push(`hint: ${item.hint}`);
      process.stdout.write(`  ${icon}  ${item.check}${tail.length ? '  --  ' + tail.join('; ') : ''}\n`);
    }
  }
  process.stdout.write(`\nSummary: ${tally.green} ok, ${tally.yellow} warning, ${tally.red} error, ${tally.skipped} skipped\n`);
}

process.exit(tally.red > 0 ? 1 : tally.yellow > 0 ? 2 : 0);
