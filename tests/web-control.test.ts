/**
 * Web control API — the browser's write path. A real broker and dashboard run
 * on test ports; teams are launched with the fake Claude CLI, so the dashboard
 * hosts the orchestrator runtime exactly as it does for a person.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { awaitingHuman, workflowInstructions } from "../dashboard/control.ts";
import type { Session, Slot } from "../shared/types.ts";

const BROKER_PORT = 17911;
const DASHBOARD_PORT = 17912;
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const DASHBOARD_URL = `http://127.0.0.1:${DASHBOARD_PORT}`;
const FAKE_CLAUDE = new URL("./fakes/fake-claude.ts", import.meta.url).pathname;
const SESSION = "web-control";

let brokerProc: import("bun").Subprocess | null = null;
let dashboardProc: import("bun").Subprocess | null = null;
let tmpDir = "";
let slotA = 0;
let slotB = 0;

async function broker(p: string, body: unknown): Promise<any> {
  const res = await fetch(`${BROKER_URL}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}

async function api(action: string, body?: unknown): Promise<{ status: number; ok: boolean; result?: any; error?: string }> {
  const res = await fetch(`${DASHBOARD_URL}/api/${action}`, body === undefined
    ? {}
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, ...(await res.json()) as any };
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await Bun.sleep(100);
  }
  throw new Error("waitFor timed out");
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-control-"));
  fs.mkdirSync(path.join(tmpDir, "proj"));
  const env = {
    ...process.env,
    HOME: tmpDir,
    MULTIAGENTS_PORT: String(BROKER_PORT),
    MULTIAGENTS_DB: path.join(tmpDir, "peers.db"),
  };
  brokerProc = Bun.spawn(["bun", new URL("../broker.ts", import.meta.url).pathname], { env, stdout: "ignore", stderr: "ignore" });
  await waitFor(async () => (await fetch(`${BROKER_URL}/health`).catch(() => null))?.ok);

  await broker("/sessions/create", { id: SESSION, name: "Web Control", project_dir: path.join(tmpDir, "proj") });
  slotA = (await broker("/slots/create", { session_id: SESSION, display_name: "Worker", agent_type: "claude", role: "Software Engineer" })).id;
  slotB = (await broker("/slots/create", { session_id: SESSION, display_name: "Reviewer", agent_type: "claude", role: "Code Reviewer" })).id;

  dashboardProc = Bun.spawn(["bun", new URL("../dashboard/server.ts", import.meta.url).pathname, SESSION], {
    env: {
      ...env,
      MULTIAGENTS_WEB_PORT: String(DASHBOARD_PORT),
      MULTIAGENTS_NO_OPEN: "1",
      MULTIAGENTS_NO_DASHBOARD: "1",
      MULTIAGENTS_CLAUDE_COMMAND: `bun ${FAKE_CLAUDE}`,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitFor(async () => (await fetch(DASHBOARD_URL).catch(() => null))?.ok);
}, 30_000);

afterAll(() => {
  dashboardProc?.kill();
  brokerProc?.kill();
});

describe("messages", () => {
  test("a message to an agent is sent as the human, addressed by slot", async () => {
    const r = await api("messages/send", { session_id: SESSION, slot_id: slotA, text: "Explain your reasoning" });
    expect(r.ok).toBe(true);
    const log = await broker("/message-log", { session_id: SESSION, limit: 10 });
    const sent = log.find((m: any) => m.text === "Explain your reasoning");
    expect(sent.from_id).toBe("human");
    expect(sent.to_slot_id).toBe(slotA);
    expect(sent.msg_type).toBe("chat");
  });

  test("a slot of another session is refused", async () => {
    await broker("/sessions/create", { id: "web-control-other", name: "Other", project_dir: tmpDir });
    const r = await api("messages/send", { session_id: "web-control-other", slot_id: slotA, text: "wrong session" });
    expect(r.status).toBe(404);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not part of session");
  });

  test("mutations name their session", async () => {
    const r = await api("messages/send", { slot_id: slotA, text: "no session" });
    expect(r.status).toBe(400);
    expect(r.error).toContain("session_id");
  });

  test("a broadcast with nobody connected fails instead of claiming success", async () => {
    const r = await api("messages/send", { session_id: SESSION, slot_id: "all", text: "anyone?" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(422);
  });

  test("a message to a paused agent is held and says so", async () => {
    expect((await api("agents/control", { session_id: SESSION, slot_id: slotA, action: "pause" })).ok).toBe(true);
    const r = await api("messages/send", { session_id: SESSION, slot_id: slotA, text: "while paused" });
    expect(r.result.warning).toContain("paused");
    expect((await api("agents/control", { session_id: SESSION, slot_id: slotA, action: "resume" })).ok).toBe(true);
    const slot = await broker("/slots/get", { id: slotA });
    expect(Boolean(slot.paused)).toBe(false);
  });
});

describe("agents", () => {
  test("rename and role changes land on the slot", async () => {
    expect((await api("agents/rename", { session_id: SESSION, slot_id: slotB, display_name: "Critic" })).ok).toBe(true);
    expect((await api("agents/role", { session_id: SESSION, slot_id: slotB, role: "QA Engineer", role_description: "Tests everything" })).ok).toBe(true);
    const slot = await broker("/slots/get", { id: slotB });
    expect(slot.display_name).toBe("Critic");
    expect(slot.role).toBe("QA Engineer");
    expect(slot.role_description).toBe("Tests everything");
  });

  test("send back moves the agent to addressing_feedback with the human's feedback", async () => {
    await broker("/slots/update", { id: slotA, task_state: "approved" });
    const r = await api("agents/feedback", { session_id: SESSION, slot_id: slotA, feedback: "Handle the empty case" });
    expect(r.ok).toBe(true);
    expect((await broker("/slots/get", { id: slotA })).task_state).toBe("addressing_feedback");
    const log = await broker("/message-log", { session_id: SESSION, limit: 5, msg_type: "feedback" });
    expect(log[0].from_id).toBe("human");
    expect(log[0].text).toContain("Handle the empty case");
  });

  test("release all approved leaves unapproved agents alone", async () => {
    await broker("/slots/update", { id: slotA, task_state: "approved" });
    await broker("/slots/update", { id: slotB, task_state: "working" });
    const r = await api("agents/release-all", { session_id: SESSION, approved_only: true });
    expect(r.ok).toBe(true);
    expect((await broker("/slots/get", { id: slotA })).task_state).toBe("released");
    expect((await broker("/slots/get", { id: slotB })).task_state).toBe("working");
  });

  test("releasing a released agent is an error", async () => {
    const r = await api("agents/release", { session_id: SESSION, slot_id: slotA });
    expect(r.ok).toBe(false);
  });
});

describe("plan", () => {
  test("add, edit, reassign and delete tasks", async () => {
    const added = await api("plan/add", { session_id: SESSION, label: "Write the parser", slot_id: slotB });
    expect(added.ok).toBe(true);
    const item = added.result.items.find((i: any) => i.label === "Write the parser");
    expect(item.assigned_to_slot).toBe(slotB);
    expect(added.result.plan.title).toBe("Web Control");

    const edited = await api("plan/edit", { session_id: SESSION, item_id: item.id, label: "Write the lexer", status: "in_progress", slot_id: null });
    const after = edited.result.items.find((i: any) => i.id === item.id);
    expect(after.label).toBe("Write the lexer");
    expect(after.status).toBe("in_progress");
    expect(after.assigned_to_slot).toBeNull();

    expect((await api("plan/edit", { session_id: SESSION, item_id: item.id, status: "nope" })).status).toBe(400);
    expect((await api("plan/edit", { session_id: "web-control-other", item_id: item.id, status: "done" })).status).toBe(404);

    const deleted = await api("plan/delete", { session_id: SESSION, item_id: item.id });
    expect(deleted.result.items.some((i: any) => i.id === item.id)).toBe(false);
    const again = await api("plan/delete", { session_id: SESSION, item_id: item.id });
    expect(again.status).toBe(404);
    expect(again.error).toBe("Plan item not found in session");
  });
});

describe("knowledge, files, guardrails", () => {
  test("knowledge put and delete", async () => {
    expect((await api("knowledge/put", { session_id: SESSION, key: "indent", value: "2 spaces", category: "convention" })).ok).toBe(true);
    let entries = await broker("/knowledge/list", { session_id: SESSION });
    expect(entries.find((e: any) => e.key === "indent").value).toBe("2 spaces");
    expect((await api("knowledge/put", { session_id: SESSION, key: "x", value: "y", category: "gossip" })).status).toBe(400);
    expect((await api("knowledge/delete", { session_id: SESSION, key: "indent" })).ok).toBe(true);
    entries = await broker("/knowledge/list", { session_id: SESSION });
    expect(entries.some((e: any) => e.key === "indent")).toBe(false);
  });

  test("acquire a lock for an agent, then force-unlock it", async () => {
    const acquired = await api("files/acquire", { session_id: SESSION, slot_id: slotB, file_path: "src/a.ts", minutes: 1 });
    expect(acquired.result.status).toBe("acquired");
    const lock = (await broker("/files/locks", { session_id: SESSION })).find((l: any) => l.file_path === "src/a.ts");
    expect(lock.held_by_slot).toBe(slotB);
    expect((await api("files/release", { session_id: SESSION, lock_id: lock.id })).ok).toBe(true);
    expect((await broker("/files/locks", { session_id: SESSION })).length).toBe(0);
  });

  test("guardrail changes record the reason", async () => {
    const r = await api("guardrail", { session_id: SESSION, guardrail_id: "max_restarts", value: 11 });
    expect(r.ok).toBe(true);
    expect(r.result.current_value).toBe(11);
    expect((await api("guardrail", { session_id: SESSION, guardrail_id: "max_restarts", value: -1 })).status).toBe(400);
  });
});

describe("sessions", () => {
  test("human gate is merged into the session config", async () => {
    await broker("/sessions/update", { id: SESSION, config: { keep: 1 } });
    expect((await api("session/human-gate", { session_id: SESSION, enabled: true })).ok).toBe(true);
    const session = await broker("/sessions/get", { id: SESSION });
    expect(JSON.parse(session.config)).toEqual({ keep: 1, human_gate: true });
  });

  test("create, export, archive and delete (with confirmation)", async () => {
    const created = await api("session/create", { name: "Scratch Session", project_dir: path.join(tmpDir, "proj") });
    expect(created.ok).toBe(true);
    const id = created.result.id;
    expect(fs.existsSync(path.join(tmpDir, "proj", ".multiagents", "session.json"))).toBe(true);
    expect((await api("session/create", { name: "Nowhere", project_dir: path.join(tmpDir, "missing") })).status).toBe(400);

    const exp = await fetch(`${DASHBOARD_URL}/api/session/export?session_id=${SESSION}`);
    expect(exp.headers.get("content-disposition")).toContain("attachment");
    const data = await exp.json() as any;
    expect(data.session.id).toBe(SESSION);
    expect(data.agents.length).toBeGreaterThanOrEqual(2);
    const times = data.messages.map((m: any) => m.sent_at);
    expect([...times].sort()).toEqual(times);

    expect((await api("session/archive", { session_id: id })).ok).toBe(true);
    expect((await broker("/sessions/get", { id })).status).toBe("archived");

    expect((await api("session/delete", { session_id: id })).status).toBe(400);
    expect((await api("session/delete", { session_id: id, confirm: id })).ok).toBe(true);
    const sessions = await broker("/sessions/list", {});
    expect(sessions.some((s: any) => s.id === id)).toBe(false);
  });
});

describe("teams", () => {
  test("a team started from the browser is launched and supervised by the dashboard", async () => {
    const r = await api("team/create", {
      project_dir: path.join(tmpDir, "team"),
      session_name: "Browser Team",
      goal: "Ship the greeting",
      agents: [{ agent_type: "claude", name: "Solo", role: "Software Engineer" }],
      workflow: { require_reviewer_approval: true, human_release: true },
    });
    expect(r.ok).toBe(true);
    const sessionId = r.result.data.session_id;
    const session = await broker("/sessions/get", { id: sessionId });
    expect(JSON.parse(session.config).human_gate).toBe(true);
    const slots = await broker("/slots/list", { session_id: sessionId });
    expect(slots.map((s: any) => s.display_name)).toEqual(["Solo"]);

    // The dashboard switched to the new session and reports the agent as its own
    const ws = new WebSocket(`ws://127.0.0.1:${DASHBOARD_PORT}/ws`);
    const state = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no state")), 5000);
      ws.onmessage = (e) => { clearTimeout(timer); resolve(JSON.parse(e.data as string).data); };
    });
    ws.close();
    expect(state.sessionId).toBe(sessionId);
    expect(state.managedSlots).toEqual([slots[0].id]);
    expect(state.humanGate).toBe(true);

    // The same name cannot be launched twice
    const dup = await api("agents/add", { session_id: sessionId, agent_type: "claude", name: "solo", role: "Reviewer", initial_task: "Review" });
    expect(dup.ok).toBe(false);

    const removed = await api("agents/remove", { session_id: sessionId, slot_id: slots[0].id });
    expect(removed.ok).toBe(true);
    expect((await broker("/slots/get", { id: slots[0].id })).task_state).toBe("released");

    expect((await api("session/end", { session_id: sessionId })).ok).toBe(true);
    expect((await broker("/sessions/get", { id: sessionId })).status).toBe("archived");
  }, 30_000);

  test("a team needs agents with names and roles", async () => {
    expect((await api("team/create", { project_dir: tmpDir, session_name: "Empty", agents: [] })).status).toBe(400);
    expect((await api("team/create", { project_dir: "relative/dir", session_name: "Rel", agents: [{ agent_type: "claude", name: "A", role: "B" }] })).status).toBe(400);
    expect((await api("team/create", { project_dir: tmpDir, session_name: "Bad", agents: [{ agent_type: "llama", name: "A", role: "B" }] })).status).toBe(400);
  });
});

describe("workflow helpers", () => {
  test("workflow rules are spelled out for the agents", () => {
    const text = workflowInstructions("Build it", { require_reviewer_approval: true, human_release: true });
    expect(text).toContain("TEAM GOAL:\nBuild it");
    expect(text).toContain("reviewer has explicitly approved");
    expect(text).toContain("A human makes the final call");
    expect(text).not.toContain("actionable");
    expect(workflowInstructions("", {})).toBe("");
  });

  test("a gated session waits on a person once every live agent is approved", () => {
    const session = { status: "active", config: JSON.stringify({ human_gate: true }) } as Session;
    const slot = (task_state: string) => ({ task_state }) as Slot;
    expect(awaitingHuman(session, [slot("approved"), slot("released")])).toBe(true);
    expect(awaitingHuman(session, [slot("approved"), slot("working")])).toBe(false);
    expect(awaitingHuman(session, [slot("released")])).toBe(false);
    expect(awaitingHuman({ ...session, config: "{}" }, [slot("approved")])).toBe(false);
    expect(awaitingHuman({ ...session, status: "archived" }, [slot("approved")])).toBe(false);
  });
});
