// Shared helpers for the check-* smoke tests.
//
// Each check is a single function that returns a normalized result:
//   { ok, service, detail?, error?, latencyMs? }
//
// The doctor aggregates these. Individual check-* scripts wrap one check
// and exit non-zero on failure for CI usage.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Load .env, .env.local in order; never override an existing process.env value.
export function loadDotEnv() {
  for (const name of ['.env', '.env.local']) {
    const full = path.join(REPO_ROOT, name);
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
  // role-radar SMTP fallback (matches send-to-self.mjs behavior)
  const rrEnv = path.resolve(REPO_ROOT, '..', 'role-radar', '.env');
  if (fs.existsSync(rrEnv)) {
    const text = fs.readFileSync(rrEnv, 'utf8');
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
}

export function ok(service, detail, latencyMs) {
  return { ok: true, service, detail: detail ?? null, latencyMs: latencyMs ?? null };
}

export function fail(service, error, detail) {
  return { ok: false, service, error: String(error?.message ?? error), detail: detail ?? null };
}

export async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function jprint(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}
