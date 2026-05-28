#!/usr/bin/env node
// Chief of Staff: Composio-managed Gmail and Calendar.
//
// Composio hosts the MCP servers and the Google OAuth flow. Instead of
// creating your own Google Cloud project, enabling Gmail/Calendar APIs, and
// downloading gcp-oauth.keys.json, you sign up at composio.dev, get an API
// key, and run this script. It authorizes Gmail and Calendar for you via
// Composio's OAuth, creates an MCP server bound to both toolkits, generates
// your per-user MCP URL, and writes it to `.mcp.composio.json`.
//
// You then point Claude Code at the new config (or merge into `.mcp.json`).
//
// Usage:
//   node tools/composio-connect.mjs                   # interactive
//   node tools/composio-connect.mjs --status          # show current state, do nothing
//   node tools/composio-connect.mjs --user-id alex    # override default user id
//
// Env:
//   COMPOSIO_API_KEY  -- required. Get from https://app.composio.dev/settings/api-keys
//   COMPOSIO_USER_ID  -- optional, defaults to "cos-user" or SELF_EMAIL slug
//
// Status: experimental. The Composio MCP path is a faster alternative to
// the manual gcp-oauth-keys.json route in MCP_SETUP.md. End-to-end auth
// flow runs in a browser; this script orchestrates and waits.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { Composio } from '@composio/core';
import { loadDotEnv, REPO_ROOT } from './check/common.mjs';
import { openUrl, askYesNo } from './browser-prompt.mjs';

loadDotEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TOOLKITS = ['gmail', 'googlecalendar'];

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i++) {
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

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function deriveUserId(args) {
  if (typeof args['user-id'] === 'string') return args['user-id'];
  if (process.env.COMPOSIO_USER_ID) return process.env.COMPOSIO_USER_ID;
  if (process.env.SELF_EMAIL) return slugify(process.env.SELF_EMAIL);
  return 'cos-user';
}

async function ensureApiKey() {
  const key = process.env.COMPOSIO_API_KEY;
  if (!key) {
    process.stderr.write(
      'COMPOSIO_API_KEY not set. Get one at https://app.composio.dev/settings/api-keys and add it to .env\n',
    );
    process.exit(2);
  }
  return key;
}

async function listConnectionsFor(composio, userId) {
  try {
    const res = await composio.connectedAccounts.list({ userIds: [userId] });
    return res?.items ?? [];
  } catch (err) {
    process.stderr.write(`failed to list connections: ${err.message}\n`);
    return [];
  }
}

function findActiveConnection(items, toolkitSlug) {
  return items.find((c) => {
    const tk = (c.toolkit?.slug || c.toolkit || '').toLowerCase();
    const status = (c.status || c.connectionData?.status || '').toUpperCase();
    return tk === toolkitSlug && (status === 'ACTIVE' || status === 'CONNECTED');
  });
}

async function authorizeToolkit(composio, userId, toolkitSlug, rl) {
  output.write(`\nAuthorizing ${toolkitSlug} for user "${userId}"...\n`);
  let request;
  try {
    request = await composio.toolkits.authorize(toolkitSlug, { alias: `cos-${toolkitSlug}` });
  } catch (err) {
    process.stderr.write(`  failed to start authorization: ${err.message}\n`);
    return false;
  }
  const redirect = request?.redirectUrl || request?.redirect_url;
  if (!redirect) {
    process.stderr.write('  no redirect URL returned by Composio\n');
    return false;
  }
  output.write(`  Open this URL to grant ${toolkitSlug} access:\n  ${redirect}\n`);
  const opened = openUrl(redirect);
  if (!opened) output.write('  (could not auto-open; copy the URL manually)\n');

  output.write('  Waiting for the connection to become active (cancel with Ctrl-C)...\n');
  try {
    const final = await request.waitForConnection?.({ timeout: 180_000 })
      ?? await composio.connectedAccounts.waitForConnection?.(request.id, { timeout: 180_000 });
    if (final && (final.status === 'ACTIVE' || final.status === 'CONNECTED')) {
      output.write(`  ${toolkitSlug}: connected.\n`);
      return true;
    }
    output.write(`  ${toolkitSlug}: connection ended with status ${final?.status ?? 'unknown'}.\n`);
    return false;
  } catch (err) {
    process.stderr.write(`  authorization wait failed: ${err.message}\n`);
    return false;
  }
}

async function createOrReuseMcpServer(composio, userId) {
  const desiredName = `cos-${userId}`;
  try {
    const existing = await composio.mcp.list({ limit: 50 });
    const match = (existing?.items ?? []).find((s) => s.name === desiredName);
    if (match) {
      output.write(`Reusing existing MCP server "${desiredName}" (id ${match.id}).\n`);
      return match;
    }
  } catch {
    // ignore; we'll just create
  }
  output.write(`Creating Composio MCP server "${desiredName}" with toolkits ${TOOLKITS.join(', ')}...\n`);
  return composio.mcp.create(desiredName, {
    toolkits: TOOLKITS,
    manuallyManageConnections: false,
  });
}

async function writeComposioMcpConfig(serverInstance, userId) {
  const url = serverInstance?.url || serverInstance?.serverUrl;
  if (!url) throw new Error('no MCP URL returned by Composio');
  const apiKey = process.env.COMPOSIO_API_KEY;
  const cfg = {
    mcpServers: {
      composio: {
        type: 'http',
        url,
        headers: { 'x-api-key': apiKey, 'x-composio-user-id': userId },
      },
    },
  };
  const outPath = path.join(REPO_ROOT, '.mcp.composio.json');
  fs.writeFileSync(outPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return { outPath, url };
}

async function statusOnly(composio, userId) {
  output.write(`User: ${userId}\n`);
  const items = await listConnectionsFor(composio, userId);
  for (const t of TOOLKITS) {
    const active = findActiveConnection(items, t);
    output.write(`  ${t.padEnd(16)}  ${active ? 'connected' : 'NOT connected'}\n`);
  }
  try {
    const servers = await composio.mcp.list({ limit: 20 });
    output.write(`\nMCP servers (${servers.items?.length ?? 0}):\n`);
    for (const s of servers.items ?? []) output.write(`  ${s.id}  ${s.name}\n`);
  } catch (err) {
    output.write(`  could not list MCP servers: ${err.message}\n`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  await ensureApiKey();
  const userId = deriveUserId(args);
  const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });

  if (args.status) {
    await statusOnly(composio, userId);
    return;
  }

  output.write(`Chief of Staff: Composio-managed Gmail and Calendar setup.\n`);
  output.write(`User id: ${userId} (override with --user-id)\n\n`);

  const rl = readline.createInterface({ input, output });
  try {
    const proceed = await askYesNo(
      'This authorizes Gmail and Calendar via Composio and writes .mcp.composio.json. Continue?',
      true,
      rl,
    );
    if (!proceed) {
      output.write('Aborted.\n');
      return;
    }

    const existing = await listConnectionsFor(composio, userId);
    const need = [];
    for (const t of TOOLKITS) {
      if (findActiveConnection(existing, t)) {
        output.write(`  ${t}: already connected.\n`);
      } else {
        need.push(t);
      }
    }

    for (const toolkit of need) {
      const ok = await authorizeToolkit(composio, userId, toolkit, rl);
      if (!ok) {
        output.write(`\nStopping: ${toolkit} did not finish authorization.\n`);
        return;
      }
    }

    const server = await createOrReuseMcpServer(composio, userId);
    if (!server?.generate) {
      throw new Error('MCP server response did not include .generate(); SDK shape may have changed');
    }
    const instance = await server.generate(userId);
    const { outPath, url } = await writeComposioMcpConfig(instance, userId);

    output.write(`\nDone. Wrote ${path.relative(REPO_ROOT, outPath)}.\n`);
    output.write(`MCP URL (kept in the file; do not paste in chat): ${url.slice(0, 60)}...\n\n`);
    output.write('Next steps:\n');
    output.write('  1. Swap your project .mcp.json to use the Composio server, OR merge .mcp.composio.json into .mcp.json.\n');
    output.write('  2. Reopen Claude Code; run `claude mcp list` to verify the composio server is connected.\n');
    output.write('  3. Run `npm run doctor` to confirm everything is healthy.\n');
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  process.stderr.write(`composio-connect: ${err.message}\n`);
  process.exit(1);
});
