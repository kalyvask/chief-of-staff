#!/usr/bin/env node
// Chief of Staff: schedule the overnight jobs (and the hooks runner) on the
// host OS. One command, OS-detected: Windows uses schtasks, macOS / Linux
// use cron (crontab -l | augment | crontab -).
//
// Tasks registered:
//   06:00 daily   /email-triage   -> logs/email-triage-YYYY-MM-DD.md
//   06:15 daily   /calendar-prep  -> logs/calendar-prep-YYYY-MM-DD.md
//   06:30 daily   hooks-runner    -> writes Yellow/Yours queue items
//
// Usage:
//   node tools/schedule.mjs              # interactive (prompts before write)
//   node tools/schedule.mjs --apply      # non-interactive (assume yes)
//   node tools/schedule.mjs --unregister # remove previously registered tasks
//   node tools/schedule.mjs --list       # show what is currently registered
//
// Idempotent: re-running --apply does not duplicate entries.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const TASKS = [
  { id: 'cos-email-triage', time: '06:00', bat: 'run-email-triage.bat', cron: '0 6 * * *', cmd: 'claude -p "/email-triage" --dangerously-skip-permissions >> logs/scheduler.log 2>&1' },
  { id: 'cos-calendar-prep', time: '06:15', bat: 'run-calendar-prep.bat', cron: '15 6 * * *', cmd: 'claude -p "/calendar-prep" --dangerously-skip-permissions >> logs/scheduler.log 2>&1' },
  { id: 'cos-hooks-runner', time: '06:30', bat: null, cron: '30 6 * * *', cmd: 'node tools/hooks-runner.mjs >> logs/hooks.log 2>&1' },
];

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = true;
    else out._.push(a);
  }
  return out;
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { shell: process.platform === 'win32' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (err) => resolve({ code: -1, stdout: '', stderr: err.message }));
  });
}

// --- Windows path ---------------------------------------------------------
async function listWindows() {
  const tasks = [];
  for (const t of TASKS) {
    const r = await run('schtasks', ['/query', '/tn', t.id, '/fo', 'LIST']);
    if (r.code === 0) tasks.push({ id: t.id, present: true });
    else tasks.push({ id: t.id, present: false });
  }
  return tasks;
}

async function applyWindows() {
  for (const t of TASKS) {
    const bat = t.bat ? path.join(REPO_ROOT, t.bat) : null;
    let action;
    if (bat && fs.existsSync(bat)) {
      action = bat;
    } else {
      // Use a direct node invocation for the hooks runner (no .bat shipped).
      action = `cmd /c "cd /d ${REPO_ROOT} && node tools\\hooks-runner.mjs >> logs\\hooks.log 2>&1"`;
    }
    const args = [
      '/create', '/tn', t.id, '/sc', 'daily', '/st', t.time,
      '/tr', action, '/f',
    ];
    const r = await run('schtasks', args);
    if (r.code !== 0) {
      output.write(`  FAIL  ${t.id}: ${r.stderr.trim() || r.stdout.trim()}\n`);
    } else {
      output.write(`  ok    ${t.id}  -> daily ${t.time}\n`);
    }
  }
}

async function unregisterWindows() {
  for (const t of TASKS) {
    const r = await run('schtasks', ['/delete', '/tn', t.id, '/f']);
    if (r.code === 0) output.write(`  removed  ${t.id}\n`);
    else output.write(`  miss     ${t.id}\n`);
  }
}

// --- Unix (cron) path -----------------------------------------------------
function cronMarker(t) {
  return `# chief-of-staff:${t.id}`;
}

async function readCrontab() {
  const r = await run('crontab', ['-l']);
  return r.code === 0 ? r.stdout : '';
}

async function writeCrontab(text) {
  return new Promise((resolve) => {
    const child = spawn('crontab', ['-'], { stdio: ['pipe', 'inherit', 'inherit'] });
    child.stdin.write(text);
    child.stdin.end();
    child.on('close', (code) => resolve(code === 0));
  });
}

async function listUnix() {
  const cron = await readCrontab();
  return TASKS.map((t) => ({ id: t.id, present: cron.includes(cronMarker(t)) }));
}

async function applyUnix() {
  let cron = await readCrontab();
  for (const t of TASKS) {
    const marker = cronMarker(t);
    if (cron.includes(marker)) {
      output.write(`  exists  ${t.id}\n`);
      continue;
    }
    cron += `\n${marker}\n${t.cron} cd ${REPO_ROOT} && ${t.cmd}\n`;
    output.write(`  add     ${t.id}  -> ${t.cron}\n`);
  }
  const ok = await writeCrontab(cron);
  if (!ok) {
    output.write('  FAIL  could not write crontab\n');
    process.exit(1);
  }
}

async function unregisterUnix() {
  let cron = await readCrontab();
  for (const t of TASKS) {
    const marker = cronMarker(t);
    const pattern = new RegExp(`\\n?${marker}[^\\n]*\\n[^\\n]*\\n?`, 'g');
    if (pattern.test(cron)) {
      cron = cron.replace(pattern, '\n');
      output.write(`  removed  ${t.id}\n`);
    }
  }
  await writeCrontab(cron);
}

// --- main -----------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv);
  const isWindows = process.platform === 'win32';

  if (args.list) {
    const items = isWindows ? await listWindows() : await listUnix();
    for (const i of items) {
      output.write(`  ${i.present ? 'present' : 'absent '}  ${i.id}\n`);
    }
    return;
  }

  if (args.unregister) {
    output.write(`Removing scheduled tasks (${isWindows ? 'Windows schtasks' : 'cron'}):\n`);
    if (isWindows) await unregisterWindows();
    else await unregisterUnix();
    return;
  }

  output.write(`\nThis will register ${TASKS.length} ${isWindows ? 'Windows scheduled tasks' : 'cron entries'}:\n`);
  for (const t of TASKS) {
    output.write(`  ${t.time}  ${t.id}  (${t.cmd.split('>>')[0].trim()})\n`);
  }

  if (!args.apply) {
    const rl = readline.createInterface({ input, output });
    const answer = (await rl.question('\nApply now? [y/N] ')).trim();
    rl.close();
    if (!/^y/i.test(answer)) {
      output.write('Aborted. Re-run with --apply to skip the prompt.\n');
      return;
    }
  }

  if (isWindows) await applyWindows();
  else await applyUnix();
  output.write('\nDone. Run `node tools/schedule.mjs --list` to verify.\n');
}

main().catch((err) => {
  output.write(`schedule: ${err.message}\n`);
  process.exit(1);
});
