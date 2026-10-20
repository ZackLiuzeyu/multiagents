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

/** A peer process that is alive now and can be killed so the cleanup loop finds it dead. */
function mortalPeer(): { pid: number; die: () => Promise<void> } {
  const proc = Bun.spawn(["sleep", "600"], { stdout: "ignore", stderr: "ignore" });
  dummies.push(proc);
  return { pid: proc.pid, die: async () => { proc.kill("SIGKILL"); await proc.exited; } };
}

async function waitForDisconnect(slotId: number): Promise<any> {
  for (let i = 0; i < 50; i++) {
    const slot = await post("/slots/get", { id: slotId });
    if (slot.status === "disconnected") return slot;
    await Bun.sleep(100);
  }
  throw new Error(`slot ${slotId} was never disconnected by the cleanup loop`);
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

describe("poll consumption modes", () => {
  test("a plain poll consumes what it returns — the contract clients without ack support rely on", async () => {
    const { sessionId, peerA, peerB } = await sessionWithTwoPeers();
    await post("/send-message", { from_id: peerB.id, to_id: peerA.id, text: "legacy", session_id: sessionId });

    const first = await post("/poll-messages", { id: peerA.id });
    expect(first.messages.map((m: any) => m.text)).toEqual(["legacy"]);
    expect((await post("/poll-messages", { id: peerA.id })).messages).toEqual([]);

    const log = await post("/message-log", { session_id: sessionId });
    expect(typeof log[0].acked_at).toBe("string");
  });

  test("a plain poll-by-slot consumes too", async () => {
    const { sessionId, slotA, peerB } = await sessionWithTwoPeers();
    await post("/send-message", { from_id: peerB.id, to_slot_id: slotA.id, text: "legacy slot", session_id: sessionId });
    expect((await post("/poll-by-slot", { slot_id: slotA.id })).messages).toHaveLength(1);
    expect((await post("/poll-by-slot", { slot_id: slotA.id })).messages).toEqual([]);
  });

  test("a plain poll of a slot's messages is also reflected in peek", async () => {
    const { sessionId, slotA, peerB } = await sessionWithTwoPeers();
    await post("/send-message", { from_id: peerB.id, to_slot_id: slotA.id, text: "consumed", session_id: sessionId });
    await post("/poll-by-slot", { slot_id: slotA.id });
    expect((await post("/peek-undelivered", { slot_id: slotA.id })).count).toBe(0);
  });
});

describe("ack semantics (retain: true)", () => {
  test("poll-messages with unclaimed_only skips messages another mechanism already handed off", async () => {
    const { sessionId, slotA, peerA, peerB } = await sessionWithTwoPeers();
    await post("/send-message", { from_id: peerB.id, to_id: peerA.id, text: "claimed by driver", session_id: sessionId });
    await post("/send-message", { from_id: peerB.id, to_id: peerA.id, text: "still unclaimed", session_id: sessionId });

    const driverPoll = await post("/poll-by-slot", { slot_id: slotA.id, retain: true });
    expect(driverPoll.messages).toHaveLength(2);
    await post("/send-message", { from_id: peerB.id, to_id: peerA.id, text: "arrived later", session_id: sessionId });

    const unclaimed = await post("/poll-messages", { id: peerA.id, unclaimed_only: true, retain: true });
    expect(unclaimed.messages.map((m: any) => m.text)).toEqual(["arrived later"]);

    const everything = await post("/poll-messages", { id: peerA.id, retain: true });
    expect(everything.messages.map((m: any) => m.text)).toEqual(["claimed by driver", "still unclaimed", "arrived later"]);
  });

  test("poll-messages keeps returning a delivered message until it is acked", async () => {
    const { sessionId, peerA, peerB } = await sessionWithTwoPeers();
    await post("/send-message", { from_id: peerB.id, to_id: peerA.id, text: "please review auth.ts", session_id: sessionId });

    const first = await post("/poll-messages", { id: peerA.id, retain: true });
    expect(first.messages.map((m: any) => m.text)).toEqual(["please review auth.ts"]);

    const second = await post("/poll-messages", { id: peerA.id, retain: true });
    expect(second.messages.map((m: any) => m.text)).toEqual(["please review auth.ts"]);
    expect(second.messages[0].delivered).toBe(1);
  });

  test("ack-messages stops a message from being polled again", async () => {
    const { sessionId, peerA, peerB } = await sessionWithTwoPeers();
    await post("/send-message", { from_id: peerB.id, to_id: peerA.id, text: "ack me", session_id: sessionId });

    const first = await post("/poll-messages", { id: peerA.id, retain: true });
    const ids = first.messages.map((m: any) => m.id);
    const ack = await post("/ack-messages", { ids });
    expect(ack.ok).toBe(true);
    expect(ack.acked).toBe(1);

    const after = await post("/poll-messages", { id: peerA.id, retain: true });
    expect(after.messages).toEqual([]);
  });

  test("ack-messages tolerates a malformed body", async () => {
    const res = await fetch(`${BROKER_URL}/ack-messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: "nope" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, acked: 0 });
  });

  test("poll-by-slot follows the same ack semantics", async () => {
    const { sessionId, slotA, peerA, peerB } = await sessionWithTwoPeers();
    await post("/send-message", { from_id: peerB.id, to_slot_id: slotA.id, text: "slot-addressed", session_id: sessionId });

    const first = await post("/poll-by-slot", { slot_id: slotA.id, retain: true });
    expect(first.messages.map((m: any) => m.text)).toEqual(["slot-addressed"]);

    const again = await post("/poll-by-slot", { slot_id: slotA.id, retain: true });
    expect(again.messages.map((m: any) => m.text)).toEqual(["slot-addressed"]);

    await post("/ack-messages", { ids: again.messages.map((m: any) => m.id) });
    const after = await post("/poll-by-slot", { slot_id: slotA.id, retain: true });
    expect(after.messages).toEqual([]);
    expect(peerA.id).toBeTruthy();
  });

  test("peek-undelivered reports unacked and unclaimed messages separately", async () => {
    const { sessionId, slotA, peerA, peerB } = await sessionWithTwoPeers();
    await post("/send-message", { from_id: peerB.id, to_id: peerA.id, text: "feedback", msg_type: "feedback", session_id: sessionId });
    await post("/poll-messages", { id: peerA.id, retain: true });
    await Bun.sleep(5);
    await post("/send-message", { from_id: peerB.id, to_id: peerA.id, text: "later", msg_type: "chat", session_id: sessionId });

    const peek = await post("/peek-undelivered", { slot_id: slotA.id });
    expect(peek.count).toBe(2);
    expect(peek.msg_types).toEqual(["feedback", "chat"]);
    expect(peek.oldest_at).toBeGreaterThan(0);
    expect(peek.unclaimed_count).toBe(1);
    expect(peek.unclaimed_msg_types).toEqual(["chat"]);
    expect(peek.unclaimed_oldest_at).toBeGreaterThanOrEqual(peek.oldest_at);

    const polled = await post("/poll-messages", { id: peerA.id, retain: true });
    await post("/ack-messages", { ids: polled.messages.map((m: any) => m.id) });
    const after = await post("/peek-undelivered", { slot_id: slotA.id });
    expect(after.count).toBe(0);
    expect(after.unclaimed_count).toBe(0);
  });

  test("message-log exposes acked_at", async () => {
    const { sessionId, peerA, peerB } = await sessionWithTwoPeers();
    await post("/send-message", { from_id: peerB.id, to_id: peerA.id, text: "logged", session_id: sessionId });
    const polled = await post("/poll-messages", { id: peerA.id, retain: true });
    expect(polled.messages[0].acked_at).toBeNull();

    await post("/ack-messages", { ids: [polled.messages[0].id] });
    const log = await post("/message-log", { session_id: sessionId });
    expect(log).toHaveLength(1);
    expect(typeof log[0].acked_at).toBe("string");
  });
});

describe("messages follow the slot", () => {
  test("a peer respawned into the same slot receives and acks messages addressed to its predecessor", async () => {
    const sessionId = uid("s");
    await post("/sessions/create", { id: sessionId, name: "follow", project_dir: "/tmp/follow" });
    const slot = await post("/slots/create", { session_id: sessionId, agent_type: "gemini", display_name: "Designer", role: "UI/UX Designer" });
    const predecessorProcess = mortalPeer();
    const predecessor = await post("/register", { agent_type: "gemini", pid: predecessorProcess.pid, cwd: "/tmp/follow", git_root: null, tty: null, summary: "", session_id: sessionId, slot_id: slot.id });
    const sender = await post("/register", { agent_type: "codex", pid: livePid(), cwd: "/tmp/follow", git_root: null, tty: null, summary: "", session_id: sessionId });
    const sent = await post("/send-message", { from_id: sender.id, to_id: predecessor.id, text: "please revisit the spec", msg_type: "feedback", session_id: sessionId });
    expect(sent.ok).toBe(true);

    await predecessorProcess.die();
    await waitForDisconnect(slot.id);

    const successor = await post("/register", { agent_type: "gemini", pid: livePid(), cwd: "/tmp/follow", git_root: null, tty: null, summary: "", session_id: sessionId, slot_id: slot.id });
    const polled = await post("/poll-messages", { id: successor.id, retain: true });
    expect(polled.messages.map((m: any) => m.text)).toEqual(["please revisit the spec"]);

    await post("/ack-messages", { ids: polled.messages.map((m: any) => m.id) });
    expect((await post("/peek-undelivered", { slot_id: slot.id })).count).toBe(0);
  });
});

describe("schema", () => {
  test("a fresh database gets the slot token columns on first start", async () => {
    const { slotA } = await sessionWithTwoPeers();
    const updated = await post("/slots/update", { id: slotA.id, input_tokens: 120, output_tokens: 30, cache_read_tokens: 5 });
    expect(updated.input_tokens).toBe(120);
    expect(updated.output_tokens).toBe(30);
    expect(updated.cache_read_tokens).toBe(5);
  });

  test("messages delivered before the ack column existed count as acked after migration", async () => {
    const { Database } = await import("bun:sqlite");
    const dbPath = `/tmp/multiagents-migrate-${Date.now()}.db`;
    const old = new Database(dbPath);
    old.run("CREATE TABLE peers (id TEXT PRIMARY KEY, pid INTEGER NOT NULL, cwd TEXT NOT NULL, git_root TEXT, tty TEXT, summary TEXT NOT NULL DEFAULT '', registered_at TEXT NOT NULL, last_seen TEXT NOT NULL, session_id TEXT, slot_id INTEGER, agent_type TEXT DEFAULT 'claude', status TEXT DEFAULT 'idle')");
    old.run("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, from_id TEXT NOT NULL, to_id TEXT NOT NULL, text TEXT NOT NULL, sent_at TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, session_id TEXT, from_slot_id INTEGER, to_slot_id INTEGER, msg_type TEXT DEFAULT 'chat', delivered_at TEXT, held INTEGER DEFAULT 0)");
    const pid = livePid();
    const now = new Date().toISOString();
    old.run("INSERT INTO peers (id, pid, cwd, registered_at, last_seen, session_id, slot_id) VALUES ('cl-old', ?, '/tmp/m', ?, ?, 'old-session', 9)", [pid, now, now]);
    old.run("INSERT INTO messages (from_id, to_id, text, sent_at, delivered, delivered_at, session_id, to_slot_id, msg_type) VALUES ('cx-x', 'cl-old', 'seen long ago', ?, 1, ?, 'old-session', 9, 'feedback')", [now, now]);
    old.run("INSERT INTO messages (from_id, to_id, text, sent_at, delivered, delivered_at, session_id, to_slot_id, msg_type) VALUES ('cx-x', 'cl-old', 'also seen', ?, 1, ?, 'old-session', 9, 'chat')", [now, now]);
    old.run("INSERT INTO messages (from_id, to_id, text, sent_at, delivered, session_id, to_slot_id, msg_type) VALUES ('cx-x', 'cl-old', 'never delivered', ?, 0, 'old-session', 9, 'chat')", [now]);
    old.close();

    const port = 17906;
    const brokerPath = new URL("../broker.ts", import.meta.url).pathname;
    const proc = Bun.spawn(["bun", brokerPath], { env: { ...process.env, MULTIAGENTS_PORT: String(port), MULTIAGENTS_DB: dbPath }, stdout: "pipe", stderr: "pipe" });
    try {
      for (let i = 0; i < 50; i++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not ready */ }
        await Bun.sleep(100);
      }
      const postThere = async (path: string, body: unknown): Promise<any> => (await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
      const peek = await postThere("/peek-undelivered", { slot_id: 9 });
      expect(peek.count).toBe(1);
      const polled = await postThere("/poll-messages", { id: "cl-old", retain: true });
      expect(polled.messages.map((m: any) => m.text)).toEqual(["never delivered"]);
    } finally {
      proc.kill();
    }
  });
});

describe("slot context snapshot", () => {
  test("context_patch merges into the existing snapshot instead of replacing it", async () => {
    const { slotA } = await sessionWithTwoPeers();
    await post("/slots/update", { id: slotA.id, context_snapshot: JSON.stringify({ claude_session_id: "sess-1", last_summary: "starting" }) });
    await post("/slots/update", { id: slotA.id, context_patch: { last_summary: "writing the parser", updated_at: 123 } });

    const slot = await post("/slots/get", { id: slotA.id });
    expect(JSON.parse(slot.context_snapshot)).toEqual({ claude_session_id: "sess-1", last_summary: "writing the parser", updated_at: 123 });
  });

  test("context_patch on a slot without a snapshot creates one", async () => {
    const { slotB } = await sessionWithTwoPeers();
    await post("/slots/update", { id: slotB.id, context_patch: { codex_thread_id: "thr-7" } });
    const slot = await post("/slots/get", { id: slotB.id });
    expect(JSON.parse(slot.context_snapshot)).toEqual({ codex_thread_id: "thr-7" });
  });

  test("stale-peer cleanup keeps the driver ids a respawn needs", async () => {
    const sessionId = uid("s");
    await post("/sessions/create", { id: sessionId, name: "snap", project_dir: "/tmp/snap" });
    const slot = await post("/slots/create", { session_id: sessionId, agent_type: "claude", display_name: "Resumable", role: "Software Engineer" });
    await post("/slots/update", { id: slot.id, context_snapshot: JSON.stringify({ claude_session_id: "sess-keep", last_summary: "mid-task" }) });
    const peerProcess = mortalPeer();
    await post("/register", { agent_type: "claude", pid: peerProcess.pid, cwd: "/tmp/snap", git_root: null, tty: null, summary: "mid-task", session_id: sessionId, slot_id: slot.id });

    await peerProcess.die();
    const after = await waitForDisconnect(slot.id);
    const snapshot = JSON.parse(after.context_snapshot);
    expect(snapshot.claude_session_id).toBe("sess-keep");
    expect(snapshot.last_status).toBe("disconnected");
  });
});

describe("stale peer cleanup", () => {
  test("messages addressed to a dead peer survive cleanup so a respawned agent can receive them", async () => {
    const sessionId = uid("s");
    await post("/sessions/create", { id: sessionId, name: "dead", project_dir: "/tmp/dead" });
    const slot = await post("/slots/create", { session_id: sessionId, agent_type: "claude", display_name: "Ghost", role: "Software Engineer" });
    const ghostProcess = mortalPeer();
    const ghost = await post("/register", { agent_type: "claude", pid: ghostProcess.pid, cwd: "/tmp/dead", git_root: null, tty: null, summary: "", session_id: sessionId, slot_id: slot.id });
    const sender = await post("/register", { agent_type: "codex", pid: livePid(), cwd: "/tmp/dead", git_root: null, tty: null, summary: "", session_id: sessionId });
    const sent = await post("/send-message", { from_id: sender.id, to_id: ghost.id, text: "fix the failing test", msg_type: "feedback", session_id: sessionId });
    expect(sent.ok).toBe(true);

    await ghostProcess.die();

    // The cleanup loop (not list-peers) is what detaches the slot — proves it ran.
    const slotAfter = await waitForDisconnect(slot.id);
    expect(slotAfter.peer_id).toBeNull();

    const peek = await post("/peek-undelivered", { slot_id: slot.id });
    expect(peek.count).toBe(1);
    const polled = await post("/poll-by-slot", { slot_id: slot.id, retain: true });
    expect(polled.messages.map((m: any) => m.text)).toEqual(["fix the failing test"]);
  });
});
