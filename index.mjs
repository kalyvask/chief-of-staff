// Chief of Staff: standalone CLI entry point.
//
// Usage:
//   npm run cos -- "your prompt here"
//   npm run cos -- "what is on my plate today"
//   npm run cos -- "/prep Acme interview tomorrow"
//
// Or directly:
//   node index.mjs "your prompt here"
//
// Reads ANTHROPIC_API_KEY from .env. Inherits user-scope MCP servers
// (Gmail, Google Calendar, Granola) automatically from ~/.claude.json,
// so no extra wiring is needed for those tools.

import dotenv from "dotenv";
dotenv.config({ override: true });

import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const userPrompt = process.argv.slice(2).join(" ").trim();
if (!userPrompt) {
  console.error('Usage: node --env-file=.env index.mjs "<your prompt>"');
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY not set. Check your .env file.");
  process.exit(1);
}

const systemPrompt = await readFile(
  resolve(__dirname, "CLAUDE.md"),
  "utf8",
);

console.log(`\n> ${userPrompt}\n`);
console.log("---");

let lastWasAssistant = false;

for await (const message of query({
  prompt: userPrompt,
  options: {
    cwd: __dirname,
    systemPrompt: { type: "preset", preset: "claude_code", append: systemPrompt },
    permissionMode: "acceptEdits",
    settingSources: ["user", "project", "local"],
  },
})) {
  switch (message.type) {
    case "assistant": {
      for (const block of message.message.content) {
        if (block.type === "text") {
          process.stdout.write(block.text);
          lastWasAssistant = true;
        } else if (block.type === "tool_use") {
          if (lastWasAssistant) process.stdout.write("\n");
          console.log(`\n[tool] ${block.name}`);
          lastWasAssistant = false;
        }
      }
      break;
    }
    case "result": {
      console.log(`\n\n---`);
      console.log(
        `done. cost: $${message.total_cost_usd?.toFixed(4) ?? "?"}, duration: ${message.duration_ms}ms, turns: ${message.num_turns}`,
      );
      break;
    }
    case "system":
    case "user":
    case "stream_event":
      // skipped; uncomment for verbose debugging
      break;
  }
}
