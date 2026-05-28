#!/usr/bin/env node
// Chief of Staff: Slack outbound helper.
//
// Posts a message to a Slack channel or thread. Used by the agent to reply
// in the same thread it was @-mentioned in. Two delivery paths, in order of
// preference:
//
//   1. SLACK_BOT_TOKEN + chat.postMessage  (supports thread replies, edits, reactions)
//   2. SLACK_WEBHOOK_URL + incoming webhook (channel-only, no threading)
//
// CLI:
//   node tools/slack-respond.mjs --channel C123 --thread 1700000000.000100 --text "drafted, see q_2026-05-20_007"
//   node tools/slack-respond.mjs --webhook --text "morning sweep complete"

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from the repo root if present (matches send-to-self.mjs style).
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnvFile(path.resolve(__dirname, "..", ".env"));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i++; }
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function postViaBotToken({ channel, thread, text, token }) {
  const body = { channel, text };
  if (thread) body.thread_ts = thread;
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`slack chat.postMessage failed: ${data.error}`);
  return { ok: true, ts: data.ts, channel: data.channel, mode: "bot-token" };
}

async function postViaWebhook({ text, url }) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`slack webhook failed: ${res.status} ${detail}`);
  }
  return { ok: true, mode: "webhook" };
}

// Programmatic API. Hooks and other modules import this directly instead of
// shelling out to the CLI. Returns the same shape the CLI prints.
//   postSlack({channel, thread, text, webhookOnly}) -> {ok, ts?, channel?, mode}
//
// Routing rules (same precedence as the CLI):
//   1. bot token + channel  -> chat.postMessage
//   2. webhook URL          -> incoming webhook (channel-only, no threading)
//   3. neither              -> throws
export async function postSlack({ channel, thread, text, webhookOnly = false } = {}) {
  if (!text || text === true) throw new Error("postSlack: text is required");

  const botToken = process.env.SLACK_BOT_TOKEN;
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;

  if (botToken && channel && !webhookOnly) {
    return await postViaBotToken({ channel, thread, text, token: botToken });
  }
  if (webhookUrl) {
    return await postViaWebhook({ text, url: webhookUrl });
  }
  if (botToken && !channel) {
    throw new Error("postSlack: --channel required when using bot token (no webhook fallback configured)");
  }
  throw new Error("postSlack: set SLACK_BOT_TOKEN (preferred) or SLACK_WEBHOOK_URL in .env");
}

// CLI entry. Only runs when invoked directly via `node tools/slack-respond.mjs`.
const isCli = process.argv[1] && (
  import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` ||
  process.argv[1].endsWith("slack-respond.mjs")
);

if (isCli) {
  const args = parseArgs(process.argv);
  try {
    const result = await postSlack({
      channel: args.channel,
      thread: args.thread,
      text: args.text,
      webhookOnly: args.webhook === true,
    });
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (err) {
    process.stderr.write(`slack-respond: ${err.message}\n`);
    process.exit(err.message.includes("required") || err.message.includes("set SLACK_") ? 2 : 1);
  }
}
