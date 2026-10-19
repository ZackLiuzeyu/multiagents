#!/usr/bin/env bun
/**
 * Driver-side delivery: unacked messages addressed to a driver-managed slot are
 * handed to the driver (Claude: stream-json stdin; Codex: steer into the active
 * turn or start a new one) and acked only once the driver confirms the hand-off.
 * Uses the real drivers against the fake hosts and a real test broker.
 */

import { test, expect, beforeAll, afterAll, afterEach, describe } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BrokerClient } from "../shared/broker-client.ts";
import { ClaudeDriver } from "../orchestrator/claude-driver.ts";
import { CodexDriver } from "../orchestrator/codex-driver.ts";
import { deliverPendingMessages, formatForwardedMessages, type DriverSlot } from "../orchestrator/delivery.ts";

const BROKER_PORT = 17903;
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const FAKE_CLAUDE = new URL("./fakes/fake-claude.ts", import.meta.url).pathname;
const FAKE_CODEX = new URL("./fakes/fake-codex-app-server.ts", import.meta.url).pathname;
const brokerClient = new BrokerClient(BROKER_URL);
let brokerProc: import("bun").Subprocess | null = null;
let counter = 0;
const dummies: import("bun").Subprocess[] = [];
const cleanups: Array<() => Promise<void>> = [];

const uid = (prefix = "t") => `${prefix}-${Date.now()}-${++counter}`;

function livePid(): number {
  const proc = Bun.spawn(["sleep", "600"], { stdout: "ignore", stderr: "ignore" });
  dummies.push(proc);
  return proc.pid;
}

async function post(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${BROKER_URL}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("timeout waiting for condition");
    await Bun.sleep(50);
  }
}

beforeAll(async () => {
  const brokerPath = new URL("../broker.ts", import.meta.url).pathname;
  brokerProc = Bun.spawn(["bun", brokerPath], {
    env: { ...process.env, MULTIAGENTS_PORT: String(BROKER_PORT), MULTIAGENTS_DB: `/tmp/multiagents-delivery-loop-${Date.now()}.db` },
    stdout: "pipe", stderr: "pipe",
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BROKER_URL}/health`)).ok) break; } catch { /* not ready */ }
    await Bun.sleep(100);
  }
});

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

afterAll(() => {
  for (const d of dummies) d.kill();
  brokerProc?.kill();
});

/** A session with a driver-managed slot (no peer) and a registered sender peer. */
async function slotWithSender(agentType: "claude" | "codex") {
  const sessionId = uid("s");
  await post("/sessions/create", { id: sessionId, name: "loop", project_dir: "/tmp/loop" });
  const slot = await post("/slots/create", { session_id: sessionId, agent_type: agentType, display_name: "Engineer", role: "Software Engineer" });
  await post("/slots/update", { id: slot.id, status: "connected" });
  const senderSlot = await post("/slots/create", { session_id: sessionId, agent_type: "codex", display_name: "Reviewer", role: "Code Reviewer" });
  const sender = await post("/register", { agent_type: "codex", pid: livePid(), cwd: "/tmp/loop", git_root: null, tty: null, summary: "", session_id: sessionId, slot_id: senderSlot.id });
  const send = (text: string, msg_type = "chat") => post("/send-message", { from_id: sender.id, to_slot_id: slot.id, text, msg_type, session_id: sessionId });
  const unacked = async () => (await post("/peek-undelivered", { slot_id: slot.id })).count as number;
  const log = async () => (await post("/message-log", { session_id: sessionId })) as Array<{ text: string; delivered: number; acked_at: string | null }>;
  return { sessionId, slot, send, unacked, log };
}

async function fakeClaude() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-claude-"));
  const logPath = path.join(dir, "fake.log");
  const driver = await ClaudeDriver.spawn({ cwd: dir, env: { ...process.env, FAKE_CLAUDE_LOG: logPath }, mcpConfig: { mcpServers: {} }, command: ["bun", FAKE_CLAUDE] });
  cleanups.push(() => driver.kill());
  const stdinTexts = () => fs.existsSync(logPath)
    ? fs.readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.stdin).map((e) => e.stdin.message.content as string)
    : [];
  return { driver, stdinTexts };
}

async function fakeCodex(opts: { start?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-codex-"));
  const logPath = path.join(dir, "fake.log");
  const driver = await CodexDriver.spawn(dir, { ...process.env, FAKE_CODEX_LOG: logPath }, { command: ["bun", FAKE_CODEX] });
  cleanups.push(() => driver.kill());
  const requests = () => fs.existsSync(logPath)
    ? fs.readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.request)
    : [];
  if (opts.start === false) return { driver, requests, threadId: null as string | null };
  const first = await driver.startSession({ prompt: "warm up", cwd: dir });
  return { driver, requests, threadId: first.threadId as string | null };
}

describe("formatForwardedMessages", () => {
  test("names the sender by slot and keeps message types", () => {
    const text = formatForwardedMessages([
      { id: 1, msg_type: "review_request", from_id: "cx-1", from_slot_id: 7, text: "please review", to_id: "", to_slot_id: 3, session_id: "s", sent_at: "t", delivered: false, delivered_at: null, acked_at: null, held: false },
      { id: 2, msg_type: "system", from_id: "orchestrator", from_slot_id: null, text: "[NUDGE] still there?", to_id: "", to_slot_id: 3, session_id: "s", sent_at: "t", delivered: false, delivered_at: null, acked_at: null, held: false },
    ], new Map([[7, { display_name: "Reviewer", role: "Code Reviewer" }]]));
    expect(text).toContain("[review_request] Reviewer (Code Reviewer) [id cx-1]: please review");
    expect(text).toContain("[system] orchestrator: [NUDGE] still there?");
  });
});

describe("Claude driver delivery", () => {
  test("pending messages are written to the session as one user message and acked once echoed", async () => {
    const { sessionId, slot, send, unacked } = await slotWithSender("claude");
    const { driver, stdinTexts } = await fakeClaude();
    await send("use port 8080");
    await send("and add tests", "feedback");
    const state: DriverSlot = { kind: "claude", driver, busy: false, lastNudge: 0 };

    expect(await deliverPendingMessages(sessionId, slot.id, state, brokerClient)).toBe("sent");

    const texts = stdinTexts();
    expect(texts).toHaveLength(1);
    expect(texts[0]!).toContain("use port 8080");
    expect(texts[0]!).toMatch(/\[feedback\] Reviewer \(Code Reviewer\) \[id cx-[a-z0-9]+\]: and add tests/);
    expect(await unacked()).toBe(0);
  });

  test("nothing pending is a no-op", async () => {
    const { sessionId, slot } = await slotWithSender("claude");
    const { driver, stdinTexts } = await fakeClaude();
    const state: DriverSlot = { kind: "claude", driver, busy: false, lastNudge: 0 };
    expect(await deliverPendingMessages(sessionId, slot.id, state, brokerClient)).toBe("none");
    expect(stdinTexts()).toHaveLength(0);
  });

  test("a dead driver is skipped and the messages stay unclaimed", async () => {
    const { sessionId, slot, send, log } = await slotWithSender("claude");
    const { driver } = await fakeClaude();
    await driver.kill();
    await send("anyone there?");
    const state: DriverSlot = { kind: "claude", driver, busy: false, lastNudge: 0 };
    expect(await deliverPendingMessages(sessionId, slot.id, state, brokerClient)).toBe("dead");
    expect((await log())[0]!.delivered).toBe(0);
  });
});

describe("Codex driver delivery", () => {
  test("messages are steered into an active turn and acked", async () => {
    const { sessionId, slot, send, unacked } = await slotWithSender("codex");
    const { driver, requests, threadId } = await fakeCodex();
    const slow = driver.reply(threadId!, "SCENARIO:slow:2000");
    await waitFor(() => driver.activeTurnId !== null);
    await send("heads up: API changed");
    const state: DriverSlot = { kind: "codex", driver, threadId, busy: false, lastNudge: 0 };

    expect(await deliverPendingMessages(sessionId, slot.id, state, brokerClient)).toBe("steered");
    expect(await unacked()).toBe(0);
    const steer = requests().find((r) => r.request === "turn/steer");
    expect(steer.params.input[0].text).toContain("heads up: API changed");
    const result = await slow;
    expect(result.content).toContain("steered:");
  });

  test("with no active turn a new turn is started and the messages are acked when it completes", async () => {
    const { sessionId, slot, send, unacked } = await slotWithSender("codex");
    const { driver, requests, threadId } = await fakeCodex();
    await send("please pick up the review");
    const state: DriverSlot = { kind: "codex", driver, threadId, busy: false, lastNudge: 0 };

    expect(await deliverPendingMessages(sessionId, slot.id, state, brokerClient)).toBe("replied");
    expect(state.busy).toBe(true);
    await waitFor(() => !state.busy, 10_000);
    expect(await unacked()).toBe(0);
    const turnStarts = requests().filter((r) => r.request === "turn/start");
    expect(turnStarts.at(-1).params.input[0].text).toContain("please pick up the review");
  });

  test("a busy slot is skipped without claiming its messages", async () => {
    const { sessionId, slot, send, log } = await slotWithSender("codex");
    const { driver, threadId } = await fakeCodex();
    await send("wait for me");
    const state: DriverSlot = { kind: "codex", driver, threadId, busy: true, lastNudge: 0 };
    expect(await deliverPendingMessages(sessionId, slot.id, state, brokerClient)).toBe("busy");
    expect((await log())[0]!.delivered).toBe(0);
  });

  test("a driver whose first turn has not completed yet is not ready", async () => {
    const { sessionId, slot, send, log } = await slotWithSender("codex");
    const { driver } = await fakeCodex({ start: false });
    await send("too early");
    const state: DriverSlot = { kind: "codex", driver, threadId: null, busy: false, lastNudge: 0 };
    expect(await deliverPendingMessages(sessionId, slot.id, state, brokerClient)).toBe("not_ready");
    expect((await log())[0]!.delivered).toBe(0);
  });
});
