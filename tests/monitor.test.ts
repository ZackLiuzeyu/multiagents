/**
 * Monitor event parsing — token accounting from the structured events the
 * drivers and processes emit (shapes as observed on Claude Code 2.1.241 and
 * the codex-cli 0.156.1 app-server schema).
 */

import { test, expect, describe } from "bun:test";
import { processEvent } from "../orchestrator/monitor.ts";

function fakeBroker() {
  const updates: Array<Record<string, unknown>> = [];
  const broker = {
    updateSlot: async (u: Record<string, unknown>) => { updates.push(u); return {}; },
    getSlot: async () => ({ task_state: "working" }),
  } as any;
  return { broker, updates };
}

describe("processEvent — Claude stream-json", () => {
  test("records token usage from the top-level `usage` of a result event", async () => {
    const { broker, updates } = fakeBroker();
    await processEvent({
      type: "result", subtype: "success", is_error: false, num_turns: 3, session_id: "s1",
      result: "All done.",
      usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 7, cache_creation_input_tokens: 500 },
      total_cost_usd: 0.01,
    }, 4242, "session-a", broker, () => {});

    const tokens = updates.find((u) => u.input_tokens !== undefined);
    expect(tokens).toEqual({ id: 4242, input_tokens: 120, output_tokens: 40, cache_read_tokens: 7 });
  });

  test("an assistant text event updates the slot summary", async () => {
    const { broker, updates } = fakeBroker();
    await processEvent({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Writing the parser now." }] } }, 4243, "session-a", broker, () => {});
    const snapshot = updates.find((u) => typeof u.context_snapshot === "string");
    expect(JSON.parse(snapshot!.context_snapshot as string).last_summary).toBe("Writing the parser now.");
  });
});
