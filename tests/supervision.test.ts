/**
 * Orchestrator supervision decisions, isolated from the MCP server: which driver
 * a slot currently owns, whether a loop tick may start, when a released driver
 * is closed, and which inbox numbers the watchdog judges a slot by.
 */

import { test, expect, describe } from "bun:test";
import {
  DriverRegistry,
  nonOverlapping,
  releaseVerdict,
  watchdogInbox,
  RELEASE_IDLE_MS,
  RELEASE_MAX_WAIT_MS,
} from "../orchestrator/supervision.ts";
import type { DriverSlot } from "../orchestrator/delivery.ts";

function claudeState(alive = true): DriverSlot {
  return { kind: "claude", driver: { alive } as any, busy: false, lastNudge: 0 };
}

describe("DriverRegistry", () => {
  test("tracking a slot that already has a live driver returns that driver so the caller can stop it", () => {
    const registry = new DriverRegistry();
    const first = claudeState();
    const second = claudeState();
    expect(registry.track("s", 1, first)).toBeNull();
    expect(registry.track("s", 1, second)).toBe(first);
    expect(registry.get("s", 1)).toBe(second);
  });

  test("a dead driver is replaced silently", () => {
    const registry = new DriverRegistry();
    const dead = claudeState(false);
    registry.track("s", 1, dead);
    expect(registry.track("s", 1, claudeState())).toBeNull();
  });

  test("detach only forgets the driver that is still registered", () => {
    const registry = new DriverRegistry();
    const old = claudeState();
    const current = claudeState();
    registry.track("s", 1, old);
    registry.track("s", 1, current);
    expect(registry.detach("s", 1, old)).toBe(false);
    expect(registry.get("s", 1)).toBe(current);
    expect(registry.detach("s", 1, current)).toBe(true);
    expect(registry.get("s", 1)).toBeUndefined();
  });

  test("isLive reports a registered driver whose process is up", () => {
    const registry = new DriverRegistry();
    registry.track("s", 1, claudeState());
    registry.track("s", 2, claudeState(false));
    expect(registry.isLive("s", 1)).toBe(true);
    expect(registry.isLive("s", 2)).toBe(false);
    expect(registry.isLive("s", 3)).toBe(false);
  });

  test("dropSession hands back the drivers and forgets the session", () => {
    const registry = new DriverRegistry();
    const state = claudeState();
    registry.track("s", 1, state);
    expect([...registry.dropSession("s")!.values()]).toEqual([state]);
    expect(registry.get("s", 1)).toBeUndefined();
    expect([...registry.sessions()]).toEqual([]);
  });
});

describe("nonOverlapping", () => {
  test("a tick that starts while the previous one is still running is skipped", async () => {
    let runs = 0;
    let release!: () => void;
    const tick = nonOverlapping(async () => { runs++; await new Promise<void>((r) => { release = r; }); });
    const first = tick();
    await tick();
    expect(runs).toBe(1);
    release();
    await first;
    const third = tick();
    expect(runs).toBe(2);
    release();
    await third;
  });

  test("a tick that throws does not block the next one", async () => {
    let runs = 0;
    const tick = nonOverlapping(async () => { runs++; throw new Error("boom"); });
    await expect(tick()).rejects.toThrow("boom");
    await expect(tick()).rejects.toThrow("boom");
    expect(runs).toBe(2);
  });
});

describe("releaseVerdict", () => {
  const now = 1_000_000;
  const base = { busy: false, turnActive: false, lastOutputAt: now, releasedAt: now, pendingCount: 0, now };

  test("a released driver with nothing in flight or pending closes", () => {
    expect(releaseVerdict(base)).toBe("close");
  });

  test("a driver still producing output in its turn is kept", () => {
    expect(releaseVerdict({ ...base, turnActive: true, lastOutputAt: now - RELEASE_IDLE_MS + 1 })).toBe("keep");
  });

  test("a turn that has produced no output for the idle period is closed", () => {
    expect(releaseVerdict({ ...base, turnActive: true, lastOutputAt: now - RELEASE_IDLE_MS })).toBe("close");
  });

  test("the release message itself still being undelivered keeps the driver", () => {
    expect(releaseVerdict({ ...base, pendingCount: 1 })).toBe("keep");
  });

  test("a forwarding turn in progress keeps the driver", () => {
    expect(releaseVerdict({ ...base, busy: true })).toBe("keep");
  });

  test("the hard cap closes a driver that never goes quiet", () => {
    const releasedAt = now - RELEASE_MAX_WAIT_MS;
    expect(releaseVerdict({ ...base, turnActive: true, lastOutputAt: now, releasedAt })).toBe("close");
    expect(releaseVerdict({ ...base, pendingCount: 2, releasedAt })).toBe("close");
    expect(releaseVerdict({ ...base, busy: true, releasedAt })).toBe("close");
  });
});

describe("watchdogInbox", () => {
  const peek = { count: 3, msg_types: ["feedback", "chat", "system"], oldest_at: 100, unclaimed_count: 1, unclaimed_msg_types: ["system"], unclaimed_oldest_at: 300 };

  test("a connected agent is judged by what no delivery mechanism picked up", () => {
    expect(watchdogInbox({ status: "connected", paused: false }, peek)).toEqual({ count: 1, msg_types: ["system"], oldest_at: 300 });
  });

  test("a disconnected agent is judged by everything still unacked", () => {
    expect(watchdogInbox({ status: "disconnected", paused: false }, peek)).toEqual({ count: 3, msg_types: ["feedback", "chat", "system"], oldest_at: 100 });
  });

  test("a paused agent is never judged", () => {
    expect(watchdogInbox({ status: "connected", paused: true }, peek)).toBeNull();
    expect(watchdogInbox({ status: "connected", paused: 1 as unknown as boolean }, peek)).toBeNull();
  });
});
