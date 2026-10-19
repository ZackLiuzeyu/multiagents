#!/usr/bin/env bun
/**
 * Delivery semantics — a message is "delivered" once a delivery mechanism
 * (adapter poll loop, driver forwarding loop) has picked it up, and "acked"
 * once it actually reached the model (piggybacked into a tool result, injected
 * into a driver turn). Until it is acked it must keep showing up, so a failed
 * or dropped delivery can be retried instead of silently lost.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";

const BROKER_PORT = 17901;
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
let brokerProc: import("bun").Subprocess | null = null;
let counter = 0;
const dummies: import("bun").Subprocess[] = [];

/** A live pid the broker may SIGTERM on shutdown without taking the test runner down. */
function livePid(): number {
  const proc = Bun.spawn(["sleep", "600"], { stdout: "ignore", stderr: "ignore" });
  dummies.push(proc);
  return proc.pid;
}

const uid = (prefix = "t") => `${prefix}-${Date.now()}-${++counter}`;

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
  const tmpDb = `/tmp/multiagents-delivery-${Date.now()}.db`;
  brokerProc = Bun.spawn(["bun", brokerPath], {
    env: {
      ...process.env,
      MULTIAGENTS_PORT: String(BROKER_PORT),
      MULTIAGENTS_DB: tmpDb,
      MULTIAGENTS_CLEANUP_INTERVAL_MS: "300",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BROKER_URL}/health`)).ok) break;
    } catch { /* not ready */ }
    await Bun.sleep(100);
  }
});

afterAll(() => {
  for (const d of dummies) d.kill();
  brokerProc?.kill();
});

/** Two live peers (pids that exist) in one session: A (claude) and B (codex). */
async function sessionWithTwoPeers() {
  const sessionId = uid("s");
  await post("/sessions/create", { id: sessionId, name: "delivery", project_dir: "/tmp/delivery" });
  const slotA = await post("/slots/create", { session_id: sessionId, agent_type: "claude", display_name: "A", role: "Software Engineer" });
  const slotB = await post("/slots/create", { session_id: sessionId, agent_type: "codex", display_name: "B", role: "Code Reviewer" });
  const peerA = await post("/register", { agent_type: "claude", pid: livePid(), cwd: "/tmp/delivery", git_root: null, tty: null, summary: "", session_id: sessionId, slot_id: slotA.id });
  const peerB = await post("/register", { agent_type: "codex", pid: livePid(), cwd: "/tmp/delivery", git_root: null, tty: null, summary: "", session_id: sessionId, slot_id: slotB.id });
  return { sessionId, slotA, slotB, peerA, peerB };
}

describe("ack semantics", () => {
  test("poll-messages with unclaimed_only skips messages another mechanism already handed off", async () => {
    const { sessionId, slotA, peerA, peerB } = await sessionWithTwoPeers();
    await post("/send-message", { from_id: peerB.id, to_id: peerA.id, text: "claimed by driver", session_id: sessionId });
    await post("/send-message", { from_id: peerB.id, to_id: peerA.id, text: "still unclaimed", session_id: sessionId });

    const driverPoll = await post("/poll-by-slot", { slot_id: slotA.id });
    expect(driverPoll.messages).toHaveLength(2);
    await post("/send-message", { from_id: peerB.id, to_id: peerA.id, text: "arrived later", session_id: sessionId });

    const unclaimed = await post("/poll-messages", { id: peerA.id, unclaimed_only: true });
    expect(unclaimed.messages.map((m: any) => m.text)).toEqual(["arrived later"]);

    const everything = await post("/poll-messages", { id: peerA.id });
    expect(everything.messages.map((m: any) => m.text)).toEqual(["claimed by driver", "still unclaimed", "arrived later"]);
  });

  test("poll-messages keeps returning a delivered message until it is acked", async () => {
    const { sessionId, peerA, peerB } = await sessionWithTwoPeers();
    await post("/send-message", { from_id: peerB.id, to_id: peerA.id, text: "please review auth.ts", session_id: sessionId });

    const first = await post("/poll-messages", { id: peerA.id });
    expect(first.messages.map((m: any) => m.text)).toEqual(["please review auth.ts"]);

    const second = await post("/poll-messages", { id: peerA.id });
    expect(second.messages.map((m: any) => m.text)).toEqual(["please review auth.ts"]);
    expect(second.messages[0].delivered).toBe(1);
  });

  test("ack-messages stops a message from being polled again", async () => {
    const { sessionId, peerA, peerB } = await sessionWithTwoPeers();
    await post("/send-message", { from_id: peerB.id, to_id: peerA.id, text: "ack me", session_id: sessionId });

    const first = await post("/poll-messages", { id: peerA.id });
    const ids = first.messages.map((m: any) => m.id);
    const ack = await post("/ack-messages", { ids });
    expect(ack.ok).toBe(true);
    expect(ack.acked).toBe(1);

    const after = await post("/poll-messages", { id: peerA.id });
    expect(after.messages).toEqual([]);
  });

  test("poll-by-slot follows the same ack semantics", async () => {
    const { sessionId, slotA, peerA, peerB } = await sessionWithTwoPeers();
    await post("/send-message", { from_id: peerB.id, to_slot_id: slotA.id, text: "slot-addressed", session_id: sessionId });

    const first = await post("/poll-by-slot", { slot_id: slotA.id });
    expect(first.messages.map((m: any) => m.text)).toEqual(["slot-addressed"]);

    const again = await post("/poll-by-slot", { slot_id: slotA.id });
    expect(again.messages.map((m: any) => m.text)).toEqual(["slot-addressed"]);

    await post("/ack-messages", { ids: again.messages.map((m: any) => m.id) });
    const after = await post("/poll-by-slot", { slot_id: slotA.id });
    expect(after.messages).toEqual([]);
    expect(peerA.id).toBeTruthy();
  });

  test("peek-undelivered counts delivered-but-unacked messages", async () => {
    const { sessionId, slotA, peerA, peerB } = await sessionWithTwoPeers();
    await post("/send-message", { from_id: peerB.id, to_id: peerA.id, text: "feedback", msg_type: "feedback", session_id: sessionId });

    await post("/poll-messages", { id: peerA.id });
    const peek = await post("/peek-undelivered", { slot_id: slotA.id });
    expect(peek.count).toBe(1);
    expect(peek.msg_types).toEqual(["feedback"]);
    expect(peek.oldest_at).toBeGreaterThan(0);

    const polled = await post("/poll-messages", { id: peerA.id });
    await post("/ack-messages", { ids: polled.messages.map((m: any) => m.id) });
    const after = await post("/peek-undelivered", { slot_id: slotA.id });
    expect(after.count).toBe(0);
  });

  test("message-log exposes acked_at", async () => {
    const { sessionId, peerA, peerB } = await sessionWithTwoPeers();
    await post("/send-message", { from_id: peerB.id, to_id: peerA.id, text: "logged", session_id: sessionId });
    const polled = await post("/poll-messages", { id: peerA.id });
    expect(polled.messages[0].acked_at).toBeNull();

    await post("/ack-messages", { ids: [polled.messages[0].id] });
    const log = await post("/message-log", { session_id: sessionId });
    expect(log).toHaveLength(1);
    expect(typeof log[0].acked_at).toBe("string");
  });
});

describe("stale peer cleanup", () => {
  test("messages addressed to a dead peer survive cleanup so a respawned agent can receive them", async () => {
    const sessionId = uid("s");
    await post("/sessions/create", { id: sessionId, name: "dead", project_dir: "/tmp/dead" });
    const slot = await post("/slots/create", { session_id: sessionId, agent_type: "claude", display_name: "Ghost", role: "Software Engineer" });
    const deadPid = 2_000_000_000;
    let deadPidIsAlive = true;
    try { process.kill(deadPid, 0); } catch { deadPidIsAlive = false; }
    expect(deadPidIsAlive).toBe(false);

    const ghost = await post("/register", { agent_type: "claude", pid: deadPid, cwd: "/tmp/dead", git_root: null, tty: null, summary: "", session_id: sessionId, slot_id: slot.id });
    const sender = await post("/register", { agent_type: "codex", pid: livePid(), cwd: "/tmp/dead", git_root: null, tty: null, summary: "", session_id: sessionId });
    await post("/send-message", { from_id: sender.id, to_id: ghost.id, text: "fix the failing test", msg_type: "feedback", session_id: sessionId });

    await Bun.sleep(900);

    // The cleanup loop (not list-peers) is what detaches the slot — proves it ran.
    const slotAfter = await post("/slots/get", { id: slot.id });
    expect(slotAfter.status).toBe("disconnected");
    expect(slotAfter.peer_id).toBeNull();
    expect(ghost.id).toBeTruthy();

    const peek = await post("/peek-undelivered", { slot_id: slot.id });
    expect(peek.count).toBe(1);
    const polled = await post("/poll-by-slot", { slot_id: slot.id });
    expect(polled.messages.map((m: any) => m.text)).toEqual(["fix the failing test"]);
  });
});
