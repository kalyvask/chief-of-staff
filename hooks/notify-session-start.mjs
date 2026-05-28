#!/usr/bin/env node
// SessionStart notification for the chief-of-staff plugin.
//
// Print one line so the user knows the plugin is loaded. Skip the noisy
// preflight by default; the doctor is one `npm run doctor` away when the
// user wants the full check. Always exit 0 so a missing env var or
// network blip does not block the session.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  // Hook may run from outside the repo (CC plugin cache) or inside it.
  // CLAUDE_PLUGIN_ROOT points at the installed plugin dir; fall back to
  // the script's parent if not set.
  const __filename = fileURLToPath(import.meta.url);
  const root = process.env.CLAUDE_PLUGIN_ROOT
    || path.resolve(path.dirname(__filename), '..');
  // Load .env (and .env.local) values into process.env if not already set.
  for (const name of ['.env', '.env.local']) {
    const full = path.join(root, name);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, 'utf8');
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  }

  const flags = [];
  if (!fs.existsSync(path.join(root, 'node_modules'))) flags.push('node_modules missing (run `npm install` in the plugin dir)');
  if (!process.env.ANTHROPIC_API_KEY) flags.push('ANTHROPIC_API_KEY missing');
  if (!process.env.SELF_EMAIL) flags.push('SELF_EMAIL missing');
  if (flags.length) {
    process.stdout.write(`chief-of-staff: ${flags.join('; ')}. Run \`npm run setup\` from ${root}.\n`);
  } else {
    process.stdout.write('chief-of-staff plugin loaded. /am-sweep to start the day. /doctor for setup status.\n');
  }
} catch {}

process.exit(0);
