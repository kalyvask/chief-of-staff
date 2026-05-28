// Browser-assisted credential prompt.
//
// Each setup step that needs a token has the same shape: tell the user
// where to go, open the URL in their default browser, wait for them to
// paste the value, validate, and return it. This module ships that loop.
//
// Usage:
//   import { promptCredential, openUrl, askYesNo } from './browser-prompt.mjs';
//   const key = await promptCredential({
//     name: 'ANTHROPIC_API_KEY',
//     url: 'https://console.anthropic.com/settings/keys',
//     instructions: 'Sign in, click Create Key, copy the value.',
//     validate: (v) => v.startsWith('sk-ant-') || 'expected sk-ant- prefix',
//   });

import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

export function openUrl(url) {
  try {
    const platform = process.platform;
    if (platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
    return true;
  } catch {
    return false;
  }
}

export async function promptCredential({ name, url, instructions, validate, secret = true, rl }) {
  const ownRl = !rl;
  rl = rl || readline.createInterface({ input, output });
  try {
    output.write(`\n${name}\n`);
    output.write(`  ${instructions}\n`);
    output.write(`  URL: ${url}\n`);
    const openIt = await rl.question('  Open in browser? [Y/n] ');
    if (!/^n/i.test(openIt.trim())) {
      const opened = openUrl(url);
      if (!opened) output.write('  (could not open browser; copy the URL manually)\n');
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const answer = (await rl.question(`  Paste ${secret ? '(hidden)' : ''}: `)).trim();
      if (!answer) {
        output.write('  Skipping. You can set this later in .env.\n');
        return null;
      }
      if (validate) {
        const result = validate(answer);
        if (result !== true && typeof result === 'string') {
          output.write(`  Invalid: ${result}. Try again.\n`);
          continue;
        }
      }
      return answer;
    }
    output.write('  Three invalid attempts; skipping.\n');
    return null;
  } finally {
    if (ownRl) rl.close();
  }
}

export async function askYesNo(question, fallback = false, rl) {
  const ownRl = !rl;
  rl = rl || readline.createInterface({ input, output });
  try {
    const yn = fallback ? '[Y/n]' : '[y/N]';
    const answer = (await rl.question(`${question} ${yn} `)).trim();
    if (!answer) return fallback;
    return /^y/i.test(answer);
  } finally {
    if (ownRl) rl.close();
  }
}

export async function askPlain(question, fallback = '', rl) {
  const ownRl = !rl;
  rl = rl || readline.createInterface({ input, output });
  try {
    const answer = (await rl.question(question + ' ')).trim();
    return answer || fallback;
  } finally {
    if (ownRl) rl.close();
  }
}
