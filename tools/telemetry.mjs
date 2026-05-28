// Chief of Staff: LLM telemetry.
//
// A thin wrapper around fetch() for Anthropic API calls that logs token usage
// + latency to data/telemetry.jsonl. Pass a ctx object naming the caller so
// cost-report can aggregate by command + subagent + model.
//
// Public API:
//   tracedFetch(url, opts, ctx)  -> Response (proxied)
//   logCall(entry)               -> append to telemetry.jsonl (for non-fetch callers)
//
// ctx fields (all optional, but recommended for useful reporting):
//   command   - "eval:agent" | "eval:drafter" | "/am-sweep" | etc.
//   actor     - "chief-of-staff" | "email-drafter" | "meeting-coach" | etc.
//   fixture   - id of the eval fixture, if applicable
//
// One JSONL line per call: {at, command, actor, model, fixture, input_tokens,
// output_tokens, cache_read_tokens, cache_creation_tokens, latency_ms, status,
// error}. Status is the HTTP code; error is the response error message if any.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TELEMETRY_PATH = path.resolve(REPO_ROOT, 'data', 'telemetry.jsonl');

export function logCall(entry) {
  try {
    fs.mkdirSync(path.dirname(TELEMETRY_PATH), { recursive: true });
    fs.appendFileSync(TELEMETRY_PATH, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch {
    // Telemetry failure should not block the call. Silent.
  }
}

export async function tracedFetch(url, opts = {}, ctx = {}) {
  const start = Date.now();
  let bodyModel = null;
  try {
    if (opts.body) {
      const parsed = JSON.parse(opts.body);
      bodyModel = parsed.model ?? null;
    }
  } catch {
    // body wasn't JSON; that's OK
  }

  let resp;
  let respJson = null;
  let error = null;
  try {
    resp = await fetch(url, opts);
  } catch (e) {
    error = e.message;
    logCall({
      command: ctx.command ?? null,
      actor: ctx.actor ?? null,
      fixture: ctx.fixture ?? null,
      model: bodyModel,
      latency_ms: Date.now() - start,
      status: 0,
      error,
    });
    throw e;
  }

  // We need to read the body for usage data, but the caller still wants the
  // Response. Clone first, read the clone, return the original.
  const latency = Date.now() - start;
  try {
    const clone = resp.clone();
    respJson = await clone.json();
  } catch {
    // not JSON; usage unavailable
  }

  const usage = respJson?.usage ?? {};
  logCall({
    command: ctx.command ?? null,
    actor: ctx.actor ?? null,
    fixture: ctx.fixture ?? null,
    model: respJson?.model ?? bodyModel,
    input_tokens: usage.input_tokens ?? null,
    output_tokens: usage.output_tokens ?? null,
    cache_read_tokens: usage.cache_read_input_tokens ?? null,
    cache_creation_tokens: usage.cache_creation_input_tokens ?? null,
    latency_ms: latency,
    status: resp.status,
    error: !resp.ok ? (respJson?.error?.message ?? `HTTP ${resp.status}`) : null,
  });

  return resp;
}
