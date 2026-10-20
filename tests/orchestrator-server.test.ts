/**
 * The orchestrator MCP server as a process: it must talk to the broker on
 * MULTIAGENTS_PORT like every other component, and serve its tools over stdio.
 */

import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { McpStdioClient } from "./helpers/mcp-stdio-client.ts";

const BROKER_PORT = 17907;
const BROKER_URL = `http://127.0.0.1:${BROKER_PORT}`;
const ORCHESTRATOR = new URL("../orchestrator/orchestrator-server.ts", import.meta.url).pathname;
const SESSION_ID = `orch-port-probe-${Date.now()}`;
let brokerProc: import("bun").Subprocess | null = null;
let client: McpStdioClient | null = null;
let tmpDir = "";

async function post(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${BROKER_URL}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-server-"));
  const brokerPath = new URL("../broker.ts", import.meta.url).pathname;
  brokerProc = Bun.spawn(["bun", brokerPath], {
    env: { ...process.env, MULTIAGENTS_PORT: String(BROKER_PORT), MULTIAGENTS_DB: path.join(tmpDir, "peers.db") },
    stdout: "ignore", stderr: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BROKER_URL}/health`)).ok) break; } catch { /* not ready */ }
    await Bun.sleep(100);
  }
  await post("/sessions/create", { id: SESSION_ID, name: "Orchestrator Port Probe", project_dir: tmpDir });
});

afterAll(() => {
  client?.kill();
  brokerProc?.kill();
});

describe("orchestrator server process", () => {
  test("talks to the broker on MULTIAGENTS_PORT rather than the default port", async () => {
    client = await McpStdioClient.spawn(["bun", ORCHESTRATOR], {
      cwd: tmpDir,
      env: { ...process.env, MULTIAGENTS_PORT: String(BROKER_PORT), MULTIAGENTS_NO_DASHBOARD: "1" },
      stderrLog: path.join(tmpDir, "orchestrator.log"),
    });
    const result = await client.callTool("list_sessions", {}, 20_000);
    expect(result.isError).toBe(false);
    expect(result.text).toContain(SESSION_ID);
  }, 40_000);
});
