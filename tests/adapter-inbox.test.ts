/**
 * BaseAdapter inbound pipeline against a scripted broker: a message must reach
 * the model exactly once even when the poll loop and check_messages overlap,
 * and an ack the broker failed to record is retried until it lands.
 */

import { test, expect, describe } from "bun:test";
import { BaseAdapter } from "../adapters/base-adapter.ts";
import type { BufferedMessage, Message } from "../shared/types.ts";

class StubAdapter extends BaseAdapter {
  delivered: BufferedMessage[] = [];
  constructor() { super("claude"); }
  async deliverMessage(msg: BufferedMessage): Promise<void> { this.delivered.push(msg); }
  getSystemPrompt(): string { return "stub"; }
  getCapabilities(): Record<string, unknown> { return {}; }
  poll() { return this.pollLoop(); }
  check() { return this.handleCheckMessages(); }
}

function message(id: number, text: string): Message {
  return {
    id, session_id: "s", from_id: "cx-sender", from_slot_id: null, to_id: "cl-me", to_slot_id: null,
    text, msg_type: "chat", sent_at: new Date().toISOString(), delivered: false, delivered_at: null, acked_at: null, held: false,
  };
}

/** Broker double: queued polls resolve on demand, acks can be made to fail, everything is recorded. */
function scriptedBroker() {
  const polls: Array<{ opts: unknown; resolve: (m: Message[]) => void }> = [];
  const acked: number[][] = [];
  let failAcks = 0;
  const broker = {
    pollMessages: (_id: string, opts: unknown) => new Promise<{ messages: Message[] }>((resolve) => {
      polls.push({ opts, resolve: (messages) => resolve({ messages }) });
    }),
    ackMessages: async (ids: number[]) => {
      if (failAcks > 0) { failAcks--; throw new Error("broker unreachable"); }
      acked.push(ids);
      return { ok: true, acked: ids.length };
    },
    listPeers: async () => [],
    listSlots: async () => [],
  };
  return { broker, polls, acked, failNextAcks: (n: number) => { failAcks = n; } };
}

function adapterWith(broker: unknown): StubAdapter {
  const adapter = new StubAdapter();
  (adapter as any).myId = "cl-me";
  (adapter as any).broker = broker;
  return adapter;
}

describe("BaseAdapter inbox", () => {
  test("check_messages joining a poll already in flight surfaces the message once and acks it once", async () => {
    const { broker, polls, acked } = scriptedBroker();
    const adapter = adapterWith(broker);

    const loop = adapter.poll();
    await Bun.sleep(5);
    const check = adapter.check();
    await Bun.sleep(5);
    expect(polls).toHaveLength(1);
    polls[0]!.resolve([message(1, "review auth.ts")]);

    const [, result] = await Promise.all([loop, check]);
    expect(result.content[0]!.text).toContain("review auth.ts");
    expect(acked).toEqual([[1]]);

    const decorated = await (adapter as any).decorateResult({ content: [{ type: "text", text: "ok" }] });
    expect(decorated.content[0].text).toBe("ok");
    expect(adapter.delivered.map((m) => m.id)).toEqual([]);
  });

  test("a message that was acked while its poll was being enriched is not staged again", async () => {
    const { broker, polls, acked } = scriptedBroker();
    const adapter = adapterWith(broker);

    const first = adapter.check();
    await Bun.sleep(5);
    polls[0]!.resolve([message(7, "first copy")]);
    const firstResult = await first;
    expect(firstResult.content[0]!.text).toContain("first copy");
    expect(acked).toEqual([[7]]);

    const loop = adapter.poll();
    await Bun.sleep(5);
    polls[1]!.resolve([message(7, "first copy")]);
    await loop;

    expect(adapter.delivered).toHaveLength(0);
    const decorated = await (adapter as any).decorateResult({ content: [{ type: "text", text: "ok" }] });
    expect(decorated.content[0].text).toBe("ok");
  });

  test("an ack the broker rejected is retried on the next poll and the message is not shown again meanwhile", async () => {
    const { broker, polls, acked, failNextAcks } = scriptedBroker();
    const adapter = adapterWith(broker);
    failNextAcks(1);

    const check = adapter.check();
    await Bun.sleep(5);
    polls[0]!.resolve([message(3, "flaky ack")]);
    expect((await check).content[0]!.text).toContain("flaky ack");
    expect(acked).toEqual([]);

    const loop = adapter.poll();
    await Bun.sleep(5);
    polls[1]!.resolve([message(3, "flaky ack")]);
    await loop;

    expect(acked).toEqual([[3]]);
    expect(adapter.delivered).toHaveLength(0);
  });

  test("polls retain messages so a crash before the model sees them leaves them in the inbox", async () => {
    const { broker, polls } = scriptedBroker();
    const adapter = adapterWith(broker);
    const loop = adapter.poll();
    await Bun.sleep(5);
    expect(polls[0]!.opts).toMatchObject({ retain: true });
    polls[0]!.resolve([]);
    await loop;
  });

  test("under a driver, check_messages consumes unclaimed messages at poll time", async () => {
    const { broker, polls, acked } = scriptedBroker();
    const adapter = adapterWith(broker);
    (adapter as any).driverMode = true;

    const check = adapter.check();
    await Bun.sleep(5);
    expect(polls[0]!.opts).toMatchObject({ unclaimedOnly: true });
    expect((polls[0]!.opts as { retain?: boolean }).retain).not.toBe(true);
    polls[0]!.resolve([message(9, "unclaimed")]);
    expect((await check).content[0]!.text).toContain("unclaimed");
    expect(acked).toEqual([]);

    const again = adapter.check();
    await Bun.sleep(5);
    polls[1]!.resolve([message(9, "unclaimed")]);
    expect((await again).content[0]!.text).toBe("No new messages.");
  });
});
