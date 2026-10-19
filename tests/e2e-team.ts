#!/usr/bin/env bun
// ============================================================================
// multiagents — E2E Team Test
// ============================================================================
// Launches a real Claude + Codex team with cross-dependent tasks and verifies
// they coordinate through the broker. Runs entirely from local dev.
//
// Usage:
//   bun tests/e2e-team.ts
//   bun tests/e2e-team.ts --timeout 300   # custom timeout in seconds
//
// Prerequisites:
//   - `claude` CLI installed and authenticated
//   - `codex` CLI installed and authenticated
//   - Broker will be auto-started if not running
// ============================================================================

// Ensure common bin directories are in PATH (Bun subprocess inherits this)
const extraPaths = ["/usr/local/bin", `${process.env.HOME}/.bun/bin`, `${process.env.HOME}/.local/bin`, "/opt/homebrew/bin"];
const currentPath = process.env.PATH ?? "";
for (const p of extraPaths) {
  if (!currentPath.includes(p)) process.env.PATH = `${p}:${currentPath}`;
}

import { BrokerClient } from "../shared/broker-client.ts";
import { DEFAULT_BROKER_PORT, BROKER_HOSTNAME } from "../shared/constants.ts";
import { launchAgent, detectAgent } from "../orchestrator/launcher.ts";
import { monitorProcess, monitorCodexDriver, monitorClaudeDriver, clearAllTracking } from "../orchestrator/monitor.ts";
import { deliverPendingMessages, type DriverSlot } from "../orchestrator/delivery.ts";
import type { AgentLaunchConfig, Slot } from "../shared/types.ts";
import type { Subprocess } from "bun";
import * as fs from "node:fs";
import * as path from "node:path";

const BROKER_URL = `http://${BROKER_HOSTNAME}:${DEFAULT_BROKER_PORT}`;
const brokerClient = new BrokerClient(BROKER_URL);

// Parse --timeout flag (default 5 minutes)
const timeoutArg = process.argv.find((a) => a.startsWith("--timeout"));
const TIMEOUT_S = timeoutArg ? parseInt(timeoutArg.split("=")[1] ?? process.argv[process.argv.indexOf("--timeout") + 1] ?? "300") : 300;

// --- Colors for terminal output ---
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

function info(msg: string) { console.log(`${C.cyan}[e2e]${C.reset} ${msg}`); }
function ok(msg: string) { console.log(`${C.green}[e2e] ✓${C.reset} ${msg}`); }
function warn(msg: string) { console.log(`${C.yellow}[e2e] !${C.reset} ${msg}`); }
function fail(msg: string) { console.error(`${C.red}[e2e] ✗${C.reset} ${msg}`); }
function heading(msg: string) { console.log(`\n${C.bold}${C.magenta}═══ ${msg} ═══${C.reset}\n`); }

// --- Ensure broker is running ---
async function ensureBroker(): Promise<void> {
  if (await brokerClient.isAlive()) {
    ok("Broker already running");
    return;
  }

  info("Starting broker daemon...");
  const brokerScript = path.resolve(import.meta.dir, "..", "broker.ts");
  const proc = Bun.spawn(["bun", brokerScript], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  proc.unref();

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await brokerClient.isAlive()) {
      ok("Broker started");
      return;
    }
  }
  throw new Error("Failed to start broker after 6 seconds");
}

// --- Check agent CLI availability ---
async function checkAgents(): Promise<{ claude: boolean; codex: boolean }> {
  const [claude, codex] = await Promise.all([
    detectAgent("claude"),
    detectAgent("codex"),
  ]);
  return { claude: claude.available, codex: codex.available };
}

// --- Cleanup helper ---
async function cleanup(sessionId: string, procs: Map<number, Subprocess>, drivers: Map<number, { kill(): Promise<void> }>) {
  info("Cleaning up...");
  for (const [slotId, driver] of drivers) {
    try { await driver.kill(); } catch { /* ok */ }
  }
  for (const [slotId, proc] of procs) {
    try { proc.kill(); } catch { /* ok */ }
  }

  // Kill orphaned MCP server child processes (they survive parent CLI kill)
  try {
    const slots = await brokerClient.listSlots(sessionId);
    for (const slot of slots) {
      if (slot.peer_id) {
        try { await brokerClient.unregister(slot.peer_id); } catch { /* ok */ }
      }
    }
  } catch { /* broker may be down */ }

  clearAllTracking();

  // Clean up temp project directory
  const tmpDir = path.join(process.cwd(), ".e2e-test-workspace");
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
}

// --- Poll until condition is met ---
async function waitFor(
  label: string,
  check: () => Promise<boolean>,
  timeoutMs: number,
  pollMs = 3000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  heading("multiagents E2E Team Test");

  const startTime = Date.now();
  const sessionId = `e2e-test-${Date.now()}`;
  const projectDir = path.join(process.cwd(), ".e2e-test-workspace");
  const procs = new Map<number, Subprocess>();
  const drivers = new Map<number, { kill(): Promise<void> }>();
  const driverStates = new Map<number, DriverSlot>();

  // Track events
  const events: Array<{ time: number; type: string; slotId: number; message: string }> = [];
  const handleEvent = (event: { type: string; slotId: number; message: string }) => {
    events.push({ time: Date.now() - startTime, ...event });
  };

  try {
    // Step 1: Check prerequisites
    heading("Step 1: Prerequisites");
    await ensureBroker();

    const available = await checkAgents();
    if (!available.claude) {
      fail("claude CLI not found. Install it: https://docs.anthropic.com/en/docs/claude-code");
      process.exit(1);
    }
    if (!available.codex) {
      fail("codex CLI not found. Install it: npm i -g @openai/codex");
      process.exit(1);
    }
    ok("Both claude and codex CLIs available");

    // Step 2: Create workspace and session
    heading("Step 2: Create Session");
    fs.mkdirSync(projectDir, { recursive: true });

    // Init git in workspace
    Bun.spawnSync(["git", "init"], { cwd: projectDir });
    Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "init"], { cwd: projectDir });

    await brokerClient.createSession({
      id: sessionId,
      name: "E2E Cross-Dependency Test",
      project_dir: projectDir,
      git_root: projectDir,
    });
    ok(`Session created: ${sessionId}`);

    // Step 3: Launch agents (need slot IDs before creating plan)
    heading("Step 3: Launch Agents");

    // Agent configs
    const claudeConfig: AgentLaunchConfig = {
      agent_type: "claude",
      name: "Claude-Engineer",
      role: "Software Engineer",
      role_description: "TypeScript engineer. Write clean, typed code. Your task has a cross-dependency with a teammate.",
      initial_task: [
        "You have TWO deliverables. Both are REQUIRED before you call signal_done.",
        "",
        "DELIVERABLE 1 — Write src/math.ts:",
        "  export function fibonacci(n: number): number",
        "  - Returns the nth Fibonacci number (0-indexed: fib(0)=0, fib(1)=1, fib(2)=1, ...)",
        "  - Throws for negative numbers",
        "  - Use iterative approach (not recursive)",
        "",
        "DELIVERABLE 2 — Store knowledge about the API you created:",
        '  Call the store_knowledge tool with key="fibonacci-api", category="decision",',
        '  and value describing the function signature and behavior.',
        "  This is REQUIRED — your teammate needs this knowledge entry to exist.",
        "",
        "THEN (after both deliverables):",
        "  1. set_summary — report what you wrote",
        "  2. send_message — tell the Codex agent that src/math.ts is ready",
        "  3. signal_done — with proof (show the file content)",
        "",
        "DO NOT call signal_done until BOTH deliverables are complete.",
      ].join("\n"),
    };

    const codexConfig: AgentLaunchConfig = {
      agent_type: "codex",
      name: "Codex-Tester",
      role: "QA Engineer",
      role_description: "Test engineer using bun:test. Wait for your teammate to finish writing src/math.ts before writing tests.",
      initial_task: [
        "Your task: Write tests for src/math.ts (a fibonacci function your teammate is writing).",
        "",
        "STEP 1: Check if src/math.ts exists. If not, wait 10 seconds and check again (up to 3 times).",
        "STEP 2: Once src/math.ts exists, read it to understand the API.",
        "STEP 3: Create tests/math.test.ts with these test cases:",
        '  import { test, expect } from "bun:test";',
        '  import { fibonacci } from "../src/math.ts";',
        "",
        "  test('fibonacci(0) === 0')",
        "  test('fibonacci(1) === 1')",
        "  test('fibonacci(10) === 55')",
        "  test('fibonacci(20) === 6765')",
        "  test('negative input throws')",
        "",
        "STEP 4: Run `bun test tests/math.test.ts` and verify all pass.",
        "STEP 5: If all tests pass, call approve(target=\"Claude-Engineer\") to approve the implementation.",
        "STEP 6: Call signal_done with the test output as proof.",
      ].join("\n"),
    };

    // Launch Claude first
    info("Launching Claude-Engineer...");
    const claudeResult = await launchAgent(sessionId, projectDir, claudeConfig, brokerClient);
    procs.set(claudeResult.slotId, claudeResult.process);
    if (claudeResult.claudeDriver) {
      drivers.set(claudeResult.slotId, claudeResult.claudeDriver);
      driverStates.set(claudeResult.slotId, { kind: "claude", driver: claudeResult.claudeDriver, busy: false, lastNudge: 0 });
      monitorClaudeDriver(claudeResult.claudeDriver, claudeResult.slotId, sessionId, brokerClient, handleEvent);
    } else {
      monitorProcess(claudeResult.process, claudeResult.slotId, sessionId, brokerClient, handleEvent);
    }
    ok(`Claude-Engineer launched: slot=${claudeResult.slotId}, pid=${claudeResult.pid}`);

    // Stagger to avoid race conditions
    await new Promise((r) => setTimeout(r, 3000));

    // Launch Codex
    info("Launching Codex-Tester...");
    const codexResult = await launchAgent(sessionId, projectDir, codexConfig, brokerClient);
    procs.set(codexResult.slotId, codexResult.process);
    if (codexResult.codexDriver) {
      drivers.set(codexResult.slotId, codexResult.codexDriver);
      driverStates.set(codexResult.slotId, { kind: "codex", driver: codexResult.codexDriver, threadId: codexResult.codexDriver.threadId, busy: false, lastNudge: 0 });
      monitorCodexDriver(codexResult.codexDriver, codexResult.slotId, sessionId, brokerClient, handleEvent);
    } else {
      monitorProcess(codexResult.process, codexResult.slotId, sessionId, brokerClient, handleEvent);
    }
    ok(`Codex-Tester launched: slot=${codexResult.slotId}, pid=${codexResult.pid}`);

    // Step 4: Create plan (now we have slot IDs)
    heading("Step 4: Create Plan");
    await brokerClient.createPlan({
      session_id: sessionId,
      title: "Cross-dependency: implement + test",
      items: [
        { label: "Write a fibonacci function in src/math.ts with proper TypeScript types", assigned_to_slot: claudeResult.slotId },
        { label: "Write tests for the fibonacci function in tests/math.test.ts using bun:test", assigned_to_slot: codexResult.slotId },
      ],
    });
    ok("Plan created with 2 items assigned to slots");

    // Send plan context to agents
    for (const agent of [
      { slotId: claudeResult.slotId, name: "Claude-Engineer" },
      { slotId: codexResult.slotId, name: "Codex-Tester" },
    ]) {
      const slot = await brokerClient.getSlot(agent.slotId);
      if (slot?.peer_id) {
        await brokerClient.sendMessage({
          from_id: "orchestrator",
          to_id: slot.peer_id,
          text: `Welcome to the team, ${agent.name}! Use get_plan to see your assigned items. Use check_team_status to see your teammates.`,
          msg_type: "system",
          session_id: sessionId,
        });
      }
    }

    // --- Driver delivery loop (the orchestrator runs the same module) ---
    // Hands unacked broker messages to each driver: Claude over stream-json
    // stdin, Codex via steer (mid-turn) or a new turn. Acked only on success.
    const forwardingInterval = setInterval(async () => {
      for (const [slotId, state] of driverStates) {
        try {
          const outcome = await deliverPendingMessages(sessionId, slotId, state, brokerClient);
          if (outcome === "sent" || outcome === "steered" || outcome === "replied") {
            info(`Delivered messages to ${state.kind} slot ${slotId} (${outcome})`);
          } else if (outcome === "failed") {
            warn(`Delivery to slot ${slotId} failed — messages stay queued`);
          }
        } catch (err) {
          warn(`Delivery error for slot ${slotId}: ${err}`);
        }
      }
    }, 3_000);

    // Step 5: Monitor progress
    heading("Step 5: Monitor Progress");
    info(`Timeout: ${TIMEOUT_S}s. Polling every 5s...`);

    const TIMEOUT_MS = TIMEOUT_S * 1000;
    let lastStatus = "";
    let srcMathExists = false;
    let testsExist = false;
    let claudeDone = false;
    let codexDone = false;
    let messagesExchanged = false;
    let knowledgeStored = false;

    const success = await waitFor(
      "both agents complete",
      async () => {
        const slots = await brokerClient.listSlots(sessionId);
        const messages = await brokerClient.getMessageLog(sessionId, { limit: 50 });

        // Check milestones
        srcMathExists = fs.existsSync(path.join(projectDir, "src", "math.ts"));
        testsExist = fs.existsSync(path.join(projectDir, "tests", "math.test.ts"));

        // Check inter-agent messages (not from orchestrator)
        const agentMessages = messages.filter((m: any) =>
          m.from_id !== "orchestrator" && m.msg_type !== "system"
        );
        messagesExchanged = agentMessages.length > 0;

        // Check knowledge store
        if (!knowledgeStored) {
          try {
            const knowledge = await brokerClient.listKnowledge(sessionId);
            knowledgeStored = knowledge.length > 0;
          } catch { /* knowledge endpoint may not be available in older broker */ }
        }

        // Check task states
        for (const slot of slots) {
          const taskState = (slot as any).task_state ?? "idle";
          if (slot.display_name === "Claude-Engineer" && (taskState === "approved" || taskState === "released")) {
            claudeDone = true;
          }
          if (slot.display_name === "Codex-Tester" && (taskState === "approved" || taskState === "released")) {
            codexDone = true;
          }
        }

        // Build status line
        const statusParts: string[] = [];
        if (srcMathExists) statusParts.push("src/math.ts ✓");
        if (testsExist) statusParts.push("tests/math.test.ts ✓");
        if (knowledgeStored) statusParts.push("knowledge ✓");
        if (messagesExchanged) statusParts.push(`messages: ${agentMessages.length}`);
        if (claudeDone) statusParts.push("Claude: done");
        if (codexDone) statusParts.push("Codex: done");

        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const newStatus = `[${elapsed}s] ${statusParts.join(" | ") || "waiting for activity..."}`;
        if (newStatus !== lastStatus) {
          info(newStatus);
          lastStatus = newStatus;
        }

        // Print slot summaries periodically
        for (const slot of slots) {
          const snap = slot.context_snapshot ? JSON.parse(slot.context_snapshot) : null;
          if (snap?.last_summary && snap.last_summary !== "(none)") {
            const name = slot.display_name ?? `slot-${slot.id}`;
            info(`  ${C.dim}${name}: ${snap.last_summary.slice(0, 100)}${C.reset}`);
          }
        }

        return claudeDone && codexDone;
      },
      TIMEOUT_MS,
      5000,
    );

    // Step 6: Report results
    heading("Step 6: Results");

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const slots = await brokerClient.listSlots(sessionId);
    const messages = await brokerClient.getMessageLog(sessionId, { limit: 100 });

    // Final milestone checks
    console.log(`\n${C.bold}Milestones:${C.reset}`);
    const check = (label: string, passed: boolean) => {
      console.log(`  ${passed ? C.green + "✓" : C.red + "✗"} ${label}${C.reset}`);
      return passed;
    };

    let allPassed = true;
    allPassed = check("src/math.ts created by Claude", srcMathExists) && allPassed;
    allPassed = check("tests/math.test.ts created by Codex", testsExist) && allPassed;
    allPassed = check("Inter-agent messages exchanged", messagesExchanged) && allPassed;
    allPassed = check("Claude-Engineer signaled done", claudeDone) && allPassed;
    allPassed = check("Codex-Tester signaled done", codexDone) && allPassed;

    // Knowledge store milestone (informational — does not fail the test)
    check("Knowledge entries stored by Claude", knowledgeStored);

    // Token usage
    console.log(`\n${C.bold}Token Usage:${C.reset}`);
    for (const slot of slots) {
      const name = slot.display_name ?? `slot-${slot.id}`;
      const input = (slot as any).input_tokens ?? 0;
      const output = (slot as any).output_tokens ?? 0;
      console.log(`  ${name}: ${input.toLocaleString()} input, ${output.toLocaleString()} output`);
    }

    // Message summary
    console.log(`\n${C.bold}Messages (${messages.length} total):${C.reset}`);
    for (const msg of messages.slice(-10)) {
      const from = msg.from_slot_id !== null ? `slot-${msg.from_slot_id}` : msg.from_id;
      const text = msg.text.slice(0, 120).replace(/\n/g, " ");
      console.log(`  ${C.dim}[${msg.msg_type}] ${from}:${C.reset} ${text}`);
    }

    // Events summary
    console.log(`\n${C.bold}Events (${events.length} total):${C.reset}`);
    for (const evt of events.slice(-10)) {
      console.log(`  ${C.dim}[${Math.round(evt.time / 1000)}s]${C.reset} ${evt.type}: ${evt.message.slice(0, 100)}`);
    }

    console.log(`\n${C.bold}Duration:${C.reset} ${elapsed}s`);

    if (allPassed && success) {
      console.log(`\n${C.green}${C.bold}═══ E2E TEST PASSED ═══${C.reset}\n`);
    } else if (!success) {
      console.log(`\n${C.yellow}${C.bold}═══ E2E TEST TIMED OUT (${TIMEOUT_S}s) ═══${C.reset}`);
      console.log(`Some milestones may have been reached. Check results above.\n`);
    } else {
      console.log(`\n${C.red}${C.bold}═══ E2E TEST FAILED ═══${C.reset}\n`);
    }

    clearInterval(forwardingInterval);
    await cleanup(sessionId, procs, drivers);
    process.exit(allPassed && success ? 0 : 1);

  } catch (err) {
    fail(`Fatal error: ${err}`);
    await cleanup(sessionId, procs, drivers);
    process.exit(2);
  }
}

main();
