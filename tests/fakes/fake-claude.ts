#!/usr/bin/env bun
/**
 * Fake `claude -p --input-format stream-json --output-format stream-json` host.
 *
 * Emits the event kinds the ClaudeDriver relies on (system/init, user echo,
 * assistant, result) with the shapes observed from Claude Code 2.1.241.
 * A "SLEEP:<ms>" marker in a prompt simulates a long tool call; messages that
 * arrive during it are absorbed into the same turn, as Claude Code does with
 * default-priority stream-json input. Argv and all stdin lines go to
 * $FAKE_CLAUDE_LOG for assertions.
 */

import * as fs from "node:fs";

const logPath = process.env.FAKE_CLAUDE_LOG;
const log = (entry: unknown) => { if (logPath) fs.appendFileSync(logPath, JSON.stringify(entry) + "\n"); };
const out = (msg: unknown) => { process.stdout.write(JSON.stringify(msg) + "\n"); };

const args = process.argv.slice(2);
log({ argv: args });

const resumeIdx = args.indexOf("--resume");
const sessionId = resumeIdx !== -1 ? args[resumeIdx + 1]! : `fake-session-${Math.random().toString(36).slice(2, 8)}`;
const replay = args.includes("--replay-user-messages");
let mcpServers: Array<{ name: string; status: string }> = [];
const mcpIdx = args.indexOf("--mcp-config");
if (mcpIdx !== -1) {
  try {
    const cfg = JSON.parse(args[mcpIdx + 1]!);
    mcpServers = Object.keys(cfg.mcpServers ?? {}).map((name) => ({ name, status: "connected" }));
  } catch { /* ignore */ }
}

// Like the real host, init is only announced once the first user message arrives.
let initSent = false;
function announceInit(): void {
  if (initSent || process.env.FAKE_CLAUDE_NO_INIT === "1") return;
  initSent = true;
  out({ type: "system", subtype: "init", session_id: sessionId, cwd: process.cwd(), model: "fake-haiku", tools: ["Bash"], mcp_servers: mcpServers });
}

const queue: any[] = [];
let absorbed: string[] = [];
let inTurn = false;
let ended = false;
let turns = 0;

function contentText(message: any): string {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b: any) => b.text ?? "").join(" ");
  return "";
}

async function runTurn(msg: any): Promise<void> {
  inTurn = true;
  turns++;
  const text = contentText(msg.message);
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `working on: ${text}` }] } });

  const sleep = text.match(/SLEEP:(\d+)/);
  if (sleep) {
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: `sleep ${sleep[1]}` } }] } });
    await new Promise((r) => setTimeout(r, parseInt(sleep[1]!, 10)));
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] } });
  }

  if (process.env.FAKE_CLAUDE_CRASH === "mid-turn") {
    process.exit(3);
  }

  const summary = `done: ${text}${absorbed.length > 0 ? ` | absorbed:${absorbed.join("|")}` : ""}`;
  absorbed = [];
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: summary }] } });
  out({
    type: "result", subtype: "success", is_error: false, num_turns: turns, session_id: sessionId,
    total_cost_usd: 0.001 * turns, duration_ms: 10, result: summary,
    usage: { input_tokens: 100 * turns, output_tokens: 20 * turns, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
  inTurn = false;
  void pump();
}

async function pump(): Promise<void> {
  if (inTurn) return;
  const next = queue.shift();
  if (next) {
    await runTurn(next);
  } else if (ended) {
    process.exit(0);
  }
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg: any;
    try { msg = JSON.parse(line); } catch { continue; }
    log({ stdin: msg });
    if (msg.type !== "user") continue;
    announceInit();
    if (replay) out({ type: "user", message: msg.message, session_id: sessionId, parent_tool_use_id: null, isReplay: true });
    if (inTurn) {
      absorbed.push(contentText(msg.message));
    } else {
      queue.push(msg);
      void pump();
    }
  }
});
process.stdin.on("end", () => {
  ended = true;
  void pump();
});
