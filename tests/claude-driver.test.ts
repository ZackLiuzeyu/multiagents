/**
 * ClaudeDriver against a fake stream-json `claude` host (tests/fakes/fake-claude.ts).
 * The fake records argv and stdin so the tests can assert the launch contract
 * and the mid-turn injection behaviour the driver depends on.
 */

import { test, expect, describe, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ClaudeDriver, buildClaudeArgs } from "../orchestrator/claude-driver.ts";

const FAKE = new URL("./fakes/fake-claude.ts", import.meta.url).pathname;
const drivers: ClaudeDriver[] = [];

afterEach(async () => {
  for (const d of drivers.splice(0)) await d.kill();
});

const MCP = { mcpServers: { "multiagents-peer": { command: "bun", args: ["x"], alwaysLoad: true } } };

async function spawnFake(extra: Partial<Parameters<typeof ClaudeDriver.spawn>[0]> = {}, env: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-driver-"));
  const logPath = path.join(dir, "fake.log");
  const driver = await ClaudeDriver.spawn({
    cwd: dir,
    env: { ...process.env, FAKE_CLAUDE_LOG: logPath, ...env },
    mcpConfig: MCP,
    command: ["bun", FAKE],
    ...extra,
  });
  drivers.push(driver);
  const entries = () => fs.readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { driver, dir, entries };
}

describe("ClaudeDriver launch contract", () => {
  test("buildClaudeArgs produces a long-lived stream-json session with the MCP config", () => {
    const args = buildClaudeArgs({ mcpConfig: MCP, appendSystemPrompt: "PROTOCOL", model: "haiku", maxTurns: 50 });
    expect(args[0]).toBe("-p");
    expect(args).toContain("--input-format");
    expect(args[args.indexOf("--input-format") + 1]).toBe("stream-json");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--verbose");
    expect(args).toContain("--replay-user-messages");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--strict-mcp-config");
    expect(JSON.parse(args[args.indexOf("--mcp-config") + 1]!)).toEqual(MCP);
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("PROTOCOL");
    expect(args[args.indexOf("--model") + 1]).toBe("haiku");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("50");
    expect(args).not.toContain("--resume");
  });

  test("spawn with a first prompt resolves after the init event with the session id and MCP status", async () => {
    const { driver, entries } = await spawnFake({ firstPrompt: "warm up" });
    expect(driver.sessionId).toMatch(/^fake-session-/);
    expect(driver.mcpServers).toEqual([{ name: "multiagents-peer", status: "connected" }]);
    expect(driver.alive).toBe(true);
    expect(entries()[0].argv).toContain("--replay-user-messages");
    expect(entries().find((e) => e.stdin)?.stdin.message.content).toBe("warm up");
  });

  test("resumeSessionId is passed as --resume and reported back as the session id", async () => {
    const { driver, entries } = await spawnFake({ resumeSessionId: "sess-123", firstPrompt: "back again" });
    expect(driver.sessionId).toBe("sess-123");
    const argv = entries()[0].argv as string[];
    expect(argv[argv.indexOf("--resume") + 1]).toBe("sess-123");
  });

  test("a session that never reports init is killed and the first send rejects", async () => {
    const { driver } = await spawnFake({ initTimeoutMs: 1500 }, { FAKE_CLAUDE_NO_INIT: "1" });
    await expect(driver.send("hello?")).rejects.toThrow(/init event/);
    await Bun.sleep(300);
    expect(driver.alive).toBe(false);
  });
});

describe("ClaudeDriver turns", () => {
  test("prompt() returns the turn result with content and usage", async () => {
    const { driver } = await spawnFake();
    const result = await driver.prompt("hello team");
    expect(result.content).toBe("done: hello team");
    expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0 });
    expect(result.numTurns).toBe(1);
    expect(driver.busy).toBe(false);
  });

  test("a message sent mid-turn is absorbed into the running turn", async () => {
    const { driver, entries } = await spawnFake();
    const turn = driver.prompt("SLEEP:1200 first task");
    await Bun.sleep(300);
    expect(driver.busy).toBe(true);
    await driver.send("teammate says: use port 8080");
    const result = await turn;
    expect(result.content).toContain("absorbed:teammate says: use port 8080");
    expect(driver.turnsCompleted).toBe(1);
    const sent = entries().filter((e) => e.stdin).map((e) => e.stdin.message.content);
    expect(sent).toEqual(["SLEEP:1200 first task", "teammate says: use port 8080"]);
  });

  test("send() resolves once the host echoes the message back", async () => {
    const { driver } = await spawnFake();
    await driver.prompt("warm up");
    const acked = await driver.send("ping");
    expect(acked).toBe(true);
    await driver.waitForTurn();
  });
});

describe("ClaudeDriver lifecycle", () => {
  test("close() ends stdin and the host exits cleanly", async () => {
    const { driver } = await spawnFake();
    await driver.prompt("warm up");
    const seen: number[] = [];
    driver.onExit((code) => { seen.push(code); });
    const code = await driver.close();
    expect(code).toBe(0);
    expect(seen).toEqual([0]);
    expect(driver.alive).toBe(false);
  });

  test("a host crash rejects the pending turn and reports the exit code", async () => {
    const { driver } = await spawnFake({}, { FAKE_CLAUDE_CRASH: "mid-turn" });
    const seen: number[] = [];
    driver.onExit((code) => { seen.push(code); });
    await expect(driver.prompt("SLEEP:200 will crash")).rejects.toThrow(/exited/);
    expect(seen).toEqual([3]);
    expect(driver.alive).toBe(false);
  });
});
