#!/usr/bin/env node
// Chief of Staff: per-command MCP tool scoping.
//
// The agent picks tools worse when it has to choose among too many. A command
// that only touches the calendar should not also be shown the whole email tool
// surface. This resolves, per command, which MCP servers it needs and turns the
// rest into a disallowedTools list the server passes to the Agent SDK.
//
// It is a blocklist by design: built-in tools (Read, Bash, Edit, ...) are never
// touched, so scoping a command can only shrink its MCP surface, never remove a
// built-in it depends on. Commands absent from data/tool-scopes.json run
// unscoped, so this is safe to roll out command by command.
//
// Public API:
//   loadScopes()                 -> the parsed config
//   detectCommand(prompt)        -> 'weekly-plan' | null   (leading slash command)
//   resolveDisallow(command)     -> {command, needed, disallow} | null
//
// CLI:
//   node tools/tool-scope.mjs resolve --command weekly-plan
//   node tools/tool-scope.mjs detect --prompt "/weekly-plan tighten my week"
//   node tools/tool-scope.mjs list
//   node tools/tool-scope.mjs self-test

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SCOPES_PATH = path.resolve(REPO_ROOT, 'data', 'tool-scopes.json');

export function loadScopes() {
  const raw = JSON.parse(fs.readFileSync(SCOPES_PATH, 'utf8'));
  return {
    mcpServers: Array.isArray(raw.mcp_servers) ? raw.mcp_servers : [],
    commands: raw.commands && typeof raw.commands === 'object' ? raw.commands : {},
  };
}

/**
 * Pull a leading slash command out of a chat prompt. Returns null when the
 * prompt is not a slash-command invocation (natural language stays unscoped).
 */
export function detectCommand(prompt) {
  if (typeof prompt !== 'string') return null;
  const m = prompt.match(/^\s*\/([a-z0-9][a-z0-9-]*)/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * For a command, return the MCP servers it does NOT need as a disallowedTools
 * list. Returns null when the command is not configured (run unscoped).
 */
export function resolveDisallow(command, scopes = null) {
  if (!command) return null;
  const cfg = scopes || loadScopes();
  if (!Object.prototype.hasOwnProperty.call(cfg.commands, command)) return null;
  const needed = cfg.commands[command] || [];
  const disallow = cfg.mcpServers
    .filter((s) => !needed.includes(s))
    .map((s) => `mcp__${s}`);
  return { command, needed, disallow };
}

// ---------------------------------------------------------------- self-test
function selfTest() {
  const cases = [];
  const ok = (name, cond) => cases.push({ name, pass: !!cond });
  const scopes = { mcpServers: ['gcal', 'gmail'], commands: { 'weekly-plan': ['gcal'], 'email-triage': ['gmail'], 'am-sweep': ['gcal', 'gmail'], think: [] } };

  ok('detect /weekly-plan', detectCommand('/weekly-plan tighten my week') === 'weekly-plan');
  ok('detect leading whitespace', detectCommand('   /am-sweep') === 'am-sweep');
  ok('detect case-insensitive', detectCommand('/Weekly-Plan') === 'weekly-plan');
  ok('no command on natural language', detectCommand('plan my week') === null);
  ok('no command on empty', detectCommand('') === null);
  ok('non-string -> null', detectCommand(null) === null);

  ok('weekly-plan disallows gmail only', JSON.stringify(resolveDisallow('weekly-plan', scopes).disallow) === JSON.stringify(['mcp__gmail']));
  ok('email-triage disallows gcal only', JSON.stringify(resolveDisallow('email-triage', scopes).disallow) === JSON.stringify(['mcp__gcal']));
  ok('am-sweep disallows nothing (needs both)', resolveDisallow('am-sweep', scopes).disallow.length === 0);
  ok('think (local) disallows both', resolveDisallow('think', scopes).disallow.length === 2);
  ok('unknown command -> null (unscoped)', resolveDisallow('made-up-command', scopes) === null);
  ok('empty command -> null', resolveDisallow('', scopes) === null);
  ok('needed list surfaced', JSON.stringify(resolveDisallow('weekly-plan', scopes).needed) === JSON.stringify(['gcal']));

  const failed = cases.filter((c) => !c.pass);
  for (const c of cases) process.stdout.write(`${c.pass ? 'ok  ' : 'FAIL'} ${c.name}\n`);
  process.stdout.write(`\n${cases.length - failed.length}/${cases.length} passed\n`);
  process.exit(failed.length ? 1 : 0);
}

// ---------------------------------------------------------------------- CLI
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function jprint(obj) { process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`); }

const cmd = process.argv[2];
const args = parseArgs(process.argv);

switch (cmd) {
  case 'resolve': {
    const command = args.command ?? args._[0];
    jprint(resolveDisallow(command));
    break;
  }
  case 'detect':
    jprint({ command: detectCommand(args.prompt ?? args._[0] ?? '') });
    break;
  case 'list':
    jprint(loadScopes());
    break;
  case 'self-test':
    selfTest();
    break;
  default:
    process.stdout.write(
      'usage: node tools/tool-scope.mjs <resolve|detect|list|self-test> [...args]\n'
      + '  resolve --command weekly-plan\n'
      + '  detect --prompt "/weekly-plan ..."\n',
    );
    process.exit(cmd ? 2 : 0);
}
