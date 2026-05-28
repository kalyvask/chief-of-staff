#!/usr/bin/env node
// chief-of-staff: scheduler health check.
//
// Diagnoses the layers a scheduled overnight run depends on. Reports
// pass / warn / fail per layer plus an exit code based on the worst result.
//
// Layers checked:
//   1. Repo working directory present and readable
//   2. Batch files (run-email-triage.bat, run-calendar-prep.bat) present
//   3. .mcp.json present and valid JSON
//   4. Google OAuth credentials file present at the path .mcp.json names
//   5. claude CLI resolvable on PATH
//   6. Windows Task Scheduler entries registered and recent run successful
//   7. Today's overnight log files contain real output, not a fail-mode log
//
// Usage:
//   node tools/check/scheduler.mjs
//   npm run check:scheduler

import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const checks = [];
function record(name, status, message) {
  checks.push({ name, status, message });
}

// Layer 1: repo root
try {
  statSync(REPO_ROOT);
  record('repo root', 'pass', REPO_ROOT);
} catch {
  record('repo root', 'fail', `cannot stat ${REPO_ROOT}`);
}

// Layer 2: batch files
for (const bat of ['run-email-triage.bat', 'run-calendar-prep.bat']) {
  const p = path.join(REPO_ROOT, bat);
  if (existsSync(p)) record(`${bat}`, 'pass', null);
  else record(`${bat}`, 'fail', `missing: ${p}`);
}

// Layer 3: .mcp.json valid
let mcp;
try {
  mcp = JSON.parse(readFileSync(path.join(REPO_ROOT, '.mcp.json'), 'utf-8'));
  const serverCount = Object.keys(mcp.mcpServers ?? {}).length;
  record('.mcp.json valid', 'pass', `${serverCount} servers declared`);
} catch (e) {
  record('.mcp.json valid', 'fail', e.message);
}

// Layer 4: Google OAuth credentials for gcal server. Hint only: the cocal
// and gongrzhe MCP packages store tokens in their own data directories, so
// a missing declared path does not always mean auth is broken. The real
// signal is the email-triage streak below.
const credPath = mcp?.mcpServers?.gcal?.env?.GOOGLE_OAUTH_CREDENTIALS;
if (credPath) {
  if (existsSync(credPath)) record('Google OAuth creds file (declared path)', 'pass', credPath);
  else record('Google OAuth creds file (declared path)', 'warn', `declared path missing: ${credPath}. MCP package may still auth via its own data dir; check the streak signal below.`);
}

// Layer 5: claude CLI in PATH
try {
  const cmd = process.platform === 'win32' ? 'where claude' : 'which claude';
  const out = execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  record('claude CLI on PATH', 'pass', out.split('\n')[0]);
} catch {
  record('claude CLI on PATH', 'fail', 'not found');
}

// Layer 6: Windows Task Scheduler
if (process.platform === 'win32') {
  for (const taskName of ['cos email triage', 'cos calendar prep']) {
    try {
      const out = execSync(`schtasks /Query /TN "${taskName}" /V /FO LIST`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const lastRun = out.match(/Last Run Time:\s+([^\r\n]+)/)?.[1]?.trim();
      const lastResult = out.match(/Last Result:\s+(\S+)/)?.[1];
      const taskStatus = out.match(/Scheduled Task State:\s+(\S+)/)?.[1] ?? out.match(/^Status:\s+(\S+)/m)?.[1];
      if (taskStatus === 'Disabled') {
        record(`schtasks "${taskName}"`, 'fail', 'task disabled');
      } else if (lastResult === '0') {
        record(`schtasks "${taskName}"`, 'pass', `last run ${lastRun} (result 0)`);
      } else if (lastResult) {
        record(`schtasks "${taskName}"`, 'warn', `last result ${lastResult}, last run ${lastRun}`);
      } else {
        record(`schtasks "${taskName}"`, 'warn', 'registered but never run');
      }
    } catch {
      record(`schtasks "${taskName}"`, 'fail', 'task not registered (run: npm run schedule)');
    }
  }
} else {
  // crontab on Unix
  try {
    const out = execSync('crontab -l', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    const hasEmailTriage = /email-triage/.test(out);
    const hasCalPrep = /calendar-prep/.test(out);
    if (hasEmailTriage) record('crontab email-triage entry', 'pass', null);
    else record('crontab email-triage entry', 'fail', 'no /email-triage entry');
    if (hasCalPrep) record('crontab calendar-prep entry', 'pass', null);
    else record('crontab calendar-prep entry', 'fail', 'no /calendar-prep entry');
  } catch {
    record('crontab', 'fail', 'no crontab configured (run: npm run schedule)');
  }
}

// Layer 7: today's overnight log status. Use local date because the
// overnight job runs at 6 AM local time and writes a local-date stamp.
const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const logsDir = path.join(REPO_ROOT, 'logs');
const expectedToday = [
  { kind: 'email-triage', path: path.join(logsDir, `email-triage-${today}.md`) },
  { kind: 'calendar-prep', path: path.join(logsDir, `calendar-prep-${today}.md`) },
];
const hoursPast6am = now.getHours() + now.getMinutes() / 60 - 6;

for (const { kind, path: logPath } of expectedToday) {
  if (!existsSync(logPath)) {
    if (hoursPast6am < 0.5) {
      record(`today's ${kind} log`, 'warn', 'before 6:30 AM, scheduled job has not fired yet');
    } else {
      record(`today's ${kind} log`, 'fail', `no log for ${today} (scheduled job did not fire or wrote elsewhere)`);
    }
    continue;
  }
  const content = readFileSync(logPath, 'utf-8');
  const failPatterns = /triage did not run|failure-mode log|not real triage|mcp.*not loading|inbox was never read|never read this run|was not exposed|MCP server was not active/i;
  if (failPatterns.test(content)) {
    record(`today's ${kind} log`, 'fail', 'fail-mode log (agent declined to fabricate; MCP likely not loading)');
  } else {
    record(`today's ${kind} log`, 'pass', `${content.length} chars of real output`);
  }
}

// Layer 8: recent fail-mode streak
const failModeStreak = [];
if (existsSync(logsDir)) {
  const files = readdirSync(logsDir)
    .filter((f) => /^email-triage-\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
    .reverse()
    .slice(0, 5);
  for (const f of files) {
    const content = readFileSync(path.join(logsDir, f), 'utf-8');
    if (/triage did not run|failure-mode log|not real triage|mcp.*not loading|inbox was never read|never read this run|was not exposed|MCP server was not active/i.test(content)) {
      failModeStreak.push(f);
    } else {
      break;
    }
  }
}
if (failModeStreak.length === 0) {
  record('email-triage streak', 'pass', 'most recent run was real');
} else if (failModeStreak.length === 1) {
  record('email-triage streak', 'warn', `1 recent fail-mode log: ${failModeStreak[0]}`);
} else {
  record('email-triage streak', 'fail', `${failModeStreak.length} consecutive fail-mode logs: ${failModeStreak.join(', ')}`);
}

// Render
const marks = { pass: 'ok  ', warn: 'WARN', fail: 'FAIL' };
const counts = { pass: 0, warn: 0, fail: 0 };
for (const c of checks) {
  const m = marks[c.status] ?? '????';
  console.log(`${m}  ${c.name}${c.message ? ': ' + c.message : ''}`);
  counts[c.status] = (counts[c.status] ?? 0) + 1;
}
console.log('');
console.log(`Summary: ${counts.pass} pass, ${counts.warn} warn, ${counts.fail} fail`);

if (counts.fail > 0) {
  console.log('');
  console.log('Likely next steps:');
  console.log('  1. If schtasks not registered: npm run schedule -- --apply');
  console.log('  2. If fail-mode streak: try `claude -p "/email-triage" --dangerously-skip-permissions --mcp-config .mcp.json` from a normal terminal and check whether Gmail tools load.');
  console.log('  3. If OAuth creds missing: re-auth the Gmail MCP via the gongrzhe package, or re-run `npm run composio:connect` if using the Composio path.');
  console.log('  4. If "last result" is non-zero on schtasks: open Task Scheduler UI, check History for the underlying error code.');
}

if (counts.fail > 0) process.exit(1);
if (counts.warn > 0) process.exit(2);
process.exit(0);
