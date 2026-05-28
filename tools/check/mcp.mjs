// Smoke-test MCP server connectivity. Runs `claude mcp list` and parses
// the output. Reports each server's connection state. Soft-pass if the
// `claude` CLI is not installed; we cannot test MCP without it.

import { spawn } from 'node:child_process';
import { ok, fail, jprint } from './common.mjs';

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

export async function checkMcp() {
  const { code, stdout, stderr } = await run('claude', ['mcp', 'list']);
  if (code === -1 || /not (recognized|found)/i.test(stderr)) {
    return fail('mcp', 'claude CLI not installed or not on PATH', 'Install Claude Code: https://claude.com/claude-code');
  }
  if (code !== 0) {
    return fail('mcp', `claude mcp list exited ${code}`, stderr.slice(0, 200));
  }
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim());
  const servers = [];
  for (const line of lines) {
    // typical line shape: "gmail: connected" or "gcal: <state>"
    const m = line.match(/^([\w-]+):\s*(.+)$/);
    if (m) servers.push({ name: m[1], state: m[2].trim() });
  }
  if (servers.length === 0) return fail('mcp', 'no MCP servers configured', stdout.slice(0, 200));

  const want = ['gmail', 'gcal'];
  const got = new Map(servers.map((s) => [s.name.toLowerCase(), s.state]));
  const missing = want.filter((w) => !got.has(w));
  const broken = servers.filter((s) => !/connected|ok/i.test(s.state));

  if (missing.length) {
    return fail('mcp', `MCP server(s) missing: ${missing.join(', ')}`, JSON.stringify(servers));
  }
  if (broken.length) {
    return fail('mcp', `MCP server(s) not connected: ${broken.map((b) => b.name).join(', ')}`, JSON.stringify(servers));
  }
  return ok('mcp', `${servers.length} servers connected: ${servers.map((s) => s.name).join(', ')}`);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('mcp.mjs')) {
  const result = await checkMcp();
  jprint(result);
  process.exit(result.ok ? 0 : 1);
}
