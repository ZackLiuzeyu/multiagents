import { test, expect, describe } from "bun:test";
import { RespawnGuard } from "../orchestrator/respawn-guard.ts";

describe("RespawnGuard", () => {
  test("only one respawn of a slot can be in flight at a time", async () => {
    const guard = new RespawnGuard();
    let concurrent = 0;
    let maxConcurrent = 0;
    const respawn = async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await Bun.sleep(50);
      concurrent--;
      return "launched";
    };

    const [a, b] = await Promise.all([guard.run(7, respawn), guard.run(7, respawn)]);
    expect(a).toBe("launched");
    expect(b).toBeNull();
    expect(maxConcurrent).toBe(1);
  });

  test("different slots respawn independently", async () => {
    const guard = new RespawnGuard();
    const results = await Promise.all([guard.run(1, async () => "one"), guard.run(2, async () => "two")]);
    expect(results).toEqual(["one", "two"]);
  });

  test("a failed respawn releases the slot for the next attempt", async () => {
    const guard = new RespawnGuard();
    await expect(guard.run(3, async () => { throw new Error("spawn failed"); })).rejects.toThrow("spawn failed");
    expect(guard.inFlight(3)).toBe(false);
    expect(await guard.run(3, async () => "retry")).toBe("retry");
  });
});
