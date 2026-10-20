#!/usr/bin/env bun
/**
 * Adapter delivery — drives real adapter processes (server.ts) over MCP stdio
 * against a test broker and checks that teammate messages reach the model
 * through tool results, are acked exactly once, and that instructions fit the
 * host CLIs' limits.
 */

import { test, expect, beforeAll, afterAll, afterEach, describe } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { McpStdioClient } from "./helpers/mcp-stdio-client.ts";
import { ClaudeAdapter } from "../adapters/claude-adapter.ts";
import { CodexAdapter } from "../adapters/codex-adapter.ts";
import { GeminiAdapter } from "../adapters/gemini-adapter.ts";

const BROKER_PORT = 17902;
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const SERVER_TS = new URL("../server.ts", import.meta.url).pathname;
let brokerProc: import("bun").Subprocess | null = null;
let counter = 0;
const dummies: import("bun").Subprocess[] = [];
const clients: McpStdioClient[] = [];

const uid = (prefix = "t") => `${prefix}-${Date.now()}-${++counter}`;

function livePid(): number {
  const proc = Bun.spawn(["sleep", "600"], { stdout: "ignore", stderr: "ignore" });
  dummies.push(proc);
  return proc.pid;
}

async function post(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

beforeAll(async () => {
  const brokerPath = new URL("../broker.ts", import.meta.url).pathname;
  brokerProc = Bun.spawn(["bun", brokerPath], {
    env: { ...process.env, MULTIAGENTS_PORT: String(BROKER_PORT), MULTIAGENTS_DB: `/tmp/multiagents-adapter-${Date.now()}.db` },
    stdout: "pipe",
    stderr: "pipe",
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BROKER_URL}/health`)).ok) break; } catch { /* not ready */ }
    await Bun.sleep(100);
  }
});

afterEach(() => {
  for (const c of clients.splice(0)) c.kill();
});

afterAll(() => {
  for (const d of dummies) d.kill();
  brokerProc?.kill();
});

/** Session with one adapter-backed slot and a sender peer (fake, live pid). */
async function spawnAgent(agentType: "claude" | "codex" | "gemini", extraEnv: Record<string, string> = {}) {
  const sessionId = uid("s");
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-delivery-"));
  await post("/sessions/create", { id: sessionId, name: "adapter", project_dir: projectDir });
  const slot = await post("/slots/create", { session_id: sessionId, agent_type: agentType, display_name: "Agent", role: "Software Engineer" });
  const senderSlot = await post("/slots/create", { session_id: sessionId, agent_type: "codex", display_name: "Reviewer", role: "Code Reviewer" });
  const sender = await post("/register", { agent_type: "codex", pid: livePid(), cwd: projectDir, git_root: null, tty: null, summary: "reviewing", session_id: sessionId, slot_id: senderSlot.id });

  const client = await McpStdioClient.spawn(["bun", SERVER_TS, "--agent-type", agentType], {
    cwd: projectDir,
    env: {
      ...process.env,
      MULTIAGENTS_PORT: String(BROKER_PORT),
      MULTIAGENTS_SESSION: sessionId,
      MULTIAGENTS_SLOT: String(slot.id),
      ...extraEnv,
    },
  });
  clients.push(client);

  let peerId: string | null = null;
  for (let i = 0; i < 50 && !peerId; i++) {
    const s = await post("/slots/get", { id: slot.id });
    peerId = s.peer_id;
    if (!peerId) await Bun.sleep(100);
  }
  if (!peerId) throw new Error("adapter never registered with the broker");

  const send = (text: string, msg_type = "chat") =>
    post("/send-message", { from_id: sender.id, to_id: peerId, text, msg_type, session_id: sessionId });
  const unacked = async () => (await post("/peek-undelivered", { slot_id: slot.id })).count as number;

  return { client, sessionId, slot, peerId, send, unacked };
}

describe("tool-result delivery", () => {
  for (const agentType of ["claude", "codex", "gemini"] as const) {
    test(`${agentType}: a teammate message is piggybacked onto the next tool result and acked`, async () => {
      const agent = await spawnAgent(agentType);
      await agent.send("please review auth.ts");
      await Bun.sleep(1500);

      const result = await agent.client.callTool("set_summary", { summary: "working" });
      expect(result.text).toContain("please review auth.ts");
      expect(result.text).toMatch(/Reviewer \(Code Reviewer\) \[id cx-[a-z0-9]+\]: please review auth\.ts/);
      expect(await agent.unacked()).toBe(0);

      const next = await agent.client.callTool("set_summary", { summary: "still working" });
      expect(next.text).not.toContain("please review auth.ts");
    }, 30_000);
  }

  test("claude: check_messages returns an unread message once and acks it", async () => {
    const agent = await spawnAgent("claude");
    await agent.send("are you done?");

    const first = await agent.client.callTool("check_messages");
    expect(first.text).toContain("are you done?");
    expect(await agent.unacked()).toBe(0);

    const second = await agent.client.callTool("check_messages");
    expect(second.text).toBe("No new messages.");
  }, 30_000);

  test("claude: the channel notification is still pushed as best-effort", async () => {
    const agent = await spawnAgent("claude");
    await agent.send("channel me");
    await Bun.sleep(1500);

    const pushed = agent.client.notifications.filter((n) => n.method === "notifications/claude/channel");
    expect(pushed).toHaveLength(1);
    expect((pushed[0]!.params as any).content).toBe("channel me");
    expect(await agent.unacked()).toBe(1);
  }, 30_000);

  test("driver mode: no background polling, check_messages returns only unclaimed messages and acks them", async () => {
    const agent = await spawnAgent("claude", { MULTIAGENTS_DRIVER_MODE: "1" });
    await agent.send("handled by the driver");
    await Bun.sleep(1500);
    expect(agent.client.notifications.filter((n) => n.method === "notifications/claude/channel")).toHaveLength(0);

    const quiet = await agent.client.callTool("set_summary", { summary: "working" });
    expect(quiet.text).not.toContain("handled by the driver");

    // The driver claims the message (poll-by-slot, retained until acked) before injecting it; the adapter must not double-deliver it.
    await post("/poll-by-slot", { slot_id: agent.slot.id, retain: true });
    await agent.send("fresh one");
    const check = await agent.client.callTool("check_messages");
    expect(check.text).toContain("fresh one");
    expect(check.text).not.toContain("handled by the driver");
    expect(await agent.unacked()).toBe(1);
  }, 30_000);
});

describe("team status", () => {
  test("check_team_status names each teammate's peer id so send_message can address them", async () => {
    const agent = await spawnAgent("claude");
    const status = await agent.client.callTool("check_team_status");
    expect(status.text).toMatch(/Reviewer \| codex \| Code Reviewer \| ONLINE \| task: idle \| id: cx-[a-z0-9]+/);
    expect(status.text).toMatch(/Agent \| claude \| Software Engineer \| ONLINE \| task: idle \| id: cl-[a-z0-9]+ \(you\)/);
  }, 30_000);
});

describe("instruction budget", () => {
  test("MCP instructions fit Claude Code's 4096-char cap for every adapter", () => {
    for (const adapter of [new ClaudeAdapter(), new CodexAdapter(), new GeminiAdapter()]) {
      const text = adapter.getInstructions();
      expect(text.length).toBeLessThanOrEqual(4096);
      expect(text).toContain("signal_done");
      expect(text).toContain("check_messages");
    }
  });

  test("the first 512 chars (all Codex reads) name the core tools", () => {
    const head = new CodexAdapter().getInstructions().slice(0, 512);
    for (const tool of ["check_messages", "send_message", "set_summary", "signal_done"]) {
      expect(head).toContain(tool);
    }
  });
});
