#!/usr/bin/env node
// Chief of Staff: setup orchestrator.
//
// One command that takes a fresh clone to a working agent. Steps:
//
//   1. npm install if node_modules missing
//   2. Copy .env.example to .env if .env missing
//   3. Prompt for ANTHROPIC_API_KEY (browser-assisted)
//   4. Prompt for SELF_EMAIL
//   5. Prompt for SMTP credentials (browser-assisted for Gmail App Password)
//   6. Optional: prompt for FORWARD_SECRET, SLACK_*
//   7. Run npm run init (the content wizard)
//   8. Run doctor and report
//
// Anything the user skips can be filled in later in .env. The doctor at
// the end shows exactly what is still missing.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { promptCredential, askYesNo, askPlain } from './browser-prompt.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', cwd: REPO_ROOT, ...opts });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    child.on('error', reject);
  });
}

function readEnvFile() {
  const p = path.join(REPO_ROOT, '.env');
  if (!fs.existsSync(p)) return { lines: [], values: {} };
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  const values = {};
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    values[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return { lines, values };
}

function writeEnvUpdates(updates) {
  // Append-only: never modify the existing .env in place. The user can edit
  // by hand if they want to replace a value.
  const p = path.join(REPO_ROOT, '.env');
  const { values } = readEnvFile();
  const additions = [];
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined || value === '') continue;
    if (values[key] && values[key] !== '') continue; // do not overwrite existing
    additions.push(`${key}=${value}`);
  }
  if (additions.length === 0) return 0;
  const sep = fs.existsSync(p) && !fs.readFileSync(p, 'utf8').endsWith('\n') ? '\n' : '';
  fs.appendFileSync(p, sep + additions.join('\n') + '\n');
  return additions.length;
}

async function main() {
  output.write('\nChief of Staff setup. This runs npm install, fills in .env, and runs the content wizard.\n');
  output.write('Ctrl-C to cancel. Anything you skip can be set later in .env.\n');

  // Step 1: npm install
  if (!fs.existsSync(path.join(REPO_ROOT, 'node_modules'))) {
    output.write('\n[1/4] Installing npm dependencies...\n');
    await run('npm', ['install']);
  } else {
    output.write('\n[1/4] node_modules already present.\n');
  }

  // Step 2: .env
  const envPath = path.join(REPO_ROOT, '.env');
  if (!fs.existsSync(envPath)) {
    const examplePath = path.join(REPO_ROOT, '.env.example');
    if (fs.existsSync(examplePath)) {
      fs.copyFileSync(examplePath, envPath);
      output.write('\n[2/4] Copied .env.example to .env.\n');
    } else {
      fs.writeFileSync(envPath, '');
      output.write('\n[2/4] Created empty .env.\n');
    }
  } else {
    output.write('\n[2/4] .env already exists; will append missing keys only.\n');
  }

  // Step 3: env vars
  output.write('\n[3/4] Fill in credentials. Press Enter to skip any.\n');
  const rl = readline.createInterface({ input, output });
  const updates = {};

  try {
    const existing = readEnvFile().values;

    if (!existing.ANTHROPIC_API_KEY) {
      updates.ANTHROPIC_API_KEY = await promptCredential({
        name: 'ANTHROPIC_API_KEY',
        url: 'https://console.anthropic.com/settings/keys',
        instructions: 'Sign in, click Create Key, copy the value here.',
        validate: (v) => v.startsWith('sk-ant-') || 'expected sk-ant- prefix',
        rl,
      });
    }

    if (!existing.SELF_EMAIL) {
      updates.SELF_EMAIL = await askPlain('SELF_EMAIL (your own email; agent drafts land here):', '', rl);
    }

    if (!existing.COMPOSIO_API_KEY) {
      const wantComposio = await askYesNo(
        'Use Composio for hosted Gmail + Calendar MCP (faster than setting up your own Google Cloud project)?',
        true,
        rl,
      );
      if (wantComposio) {
        updates.COMPOSIO_API_KEY = await promptCredential({
          name: 'COMPOSIO_API_KEY',
          url: 'https://app.composio.dev/settings/api-keys',
          instructions: 'Sign in to Composio, create an API key, paste it here.',
          rl,
        });
        if (updates.COMPOSIO_API_KEY) {
          output.write('  After setup, run `npm run composio:connect` to authorize Gmail and Calendar.\n');
        }
      }
    }

    if (!existing.SMTP_HOST && !existing.ROLE_RADAR_SMTP_HOST) {
      const wantSmtp = await askYesNo('Set up SMTP for the email-drafter (Gmail App Password recommended)?', false, rl);
      if (wantSmtp) {
        updates.SMTP_HOST = await askPlain('SMTP_HOST (e.g. smtp.gmail.com):', 'smtp.gmail.com', rl);
        updates.SMTP_PORT = await askPlain('SMTP_PORT (587 for STARTTLS, 465 for SSL):', '587', rl);
        updates.SMTP_USERNAME = await askPlain('SMTP_USERNAME (your full email address):', existing.SELF_EMAIL || updates.SELF_EMAIL || '', rl);
        updates.SMTP_PASSWORD = await promptCredential({
          name: 'SMTP_PASSWORD',
          url: 'https://myaccount.google.com/apppasswords',
          instructions: 'Create an App Password for "Mail" (requires 2FA). Paste the 16-char value.',
          validate: (v) => v.length >= 8 || 'too short for an App Password',
          rl,
        });
        updates.SMTP_FROM = updates.SMTP_USERNAME;
      }
    }

    if (!existing.FORWARD_SECRET) {
      const wantForward = await askYesNo('Set up the forwarding-address inbound channel (see FORWARD_SETUP.md)?', false, rl);
      if (wantForward) {
        const auto = await askYesNo('Generate a random FORWARD_SECRET for you?', true, rl);
        updates.FORWARD_SECRET = auto
          ? Array.from(crypto.getRandomValues(new Uint8Array(24))).map((b) => b.toString(16).padStart(2, '0')).join('')
          : await askPlain('FORWARD_SECRET (a long random string):', '', rl);
      }
    }

    if (!existing.SLACK_SIGNING_SECRET && !existing.SLACK_BOT_TOKEN) {
      const wantSlack = await askYesNo('Set up the Slack thread surface (see SLACK_SETUP.md)?', false, rl);
      if (wantSlack) {
        updates.SLACK_SIGNING_SECRET = await promptCredential({
          name: 'SLACK_SIGNING_SECRET',
          url: 'https://api.slack.com/apps',
          instructions: 'Open your Slack app, copy Signing Secret from Basic Information.',
          rl,
        });
        updates.SLACK_BOT_TOKEN = await promptCredential({
          name: 'SLACK_BOT_TOKEN',
          url: 'https://api.slack.com/apps',
          instructions: 'OAuth & Permissions -> Bot User OAuth Token (xoxb-...).',
          validate: (v) => v.startsWith('xoxb-') || 'expected xoxb- prefix',
          rl,
        });
      }
    }
  } finally {
    rl.close();
  }

  const written = writeEnvUpdates(updates);
  output.write(`\nWrote ${written} new env values to .env.\n`);

  // Step 4: init wizard for content
  output.write('\n[4/4] Run the content wizard now? (sets CLAUDE.md, AGENTS.md, context files)\n');
  const rl2 = readline.createInterface({ input, output });
  let wantInit = false;
  try {
    wantInit = await askYesNo('Run npm run init?', true, rl2);
  } finally {
    rl2.close();
  }
  if (wantInit) {
    try {
      await run('node', ['tools/init-wizard.mjs']);
    } catch (err) {
      output.write(`init wizard exited with error: ${err.message}\n`);
    }
  } else {
    output.write('Skipped. Run `npm run init` when you are ready.\n');
  }

  // Final doctor pass.
  output.write('\nRunning doctor to show what is still missing...\n');
  try {
    await run('node', ['tools/doctor.mjs', '--quick']);
  } catch {
    // Doctor exits non-zero on RED/YELLOW; expected on first run.
  }
  output.write('\nSetup complete. For a full live check, run: npm run doctor\n');
}

main().catch((err) => {
  output.write(`\nsetup: ${err.message}\n`);
  process.exit(1);
});
