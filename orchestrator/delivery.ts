// ============================================================================
// multiagents — Driver-side message delivery
// ============================================================================
// Hands unacked broker messages for a driver-managed slot to its driver and
// acks them only once the driver confirms the hand-off, so a failed delivery
// is retried on the next cycle instead of being lost.
// ============================================================================

import type { BrokerClient } from "../shared/broker-client.ts";
import type { Message } from "../shared/types.ts";
import type { CodexDriver } from "./codex-driver.ts";
import type { ClaudeDriver } from "./claude-driver.ts";
import { log } from "../shared/utils.ts";

const LOG_PREFIX = "delivery";

export type DriverSlot =
  | { kind: "codex"; driver: CodexDriver; threadId: string | null; busy: boolean; lastNudge: number; releasedAt?: number }
  | { kind: "claude"; driver: ClaudeDriver; busy: boolean; lastNudge: number; releasedAt?: number };

export type DeliveryOutcome = "dead" | "not_ready" | "busy" | "none" | "steered" | "replied" | "sent" | "failed";

type SenderInfo = { display_name: string | null; role: string | null };

/** One line per message: type, sender name/role and the peer id to reply to. */
export function formatForwardedMessages(messages: Message[], senders: Map<number, SenderInfo>): string {
  return messages.map((m) => {
    const sender = m.from_slot_id !== null ? senders.get(m.from_slot_id) : undefined;
    const name = sender?.display_name ?? (m.from_slot_id !== null ? `slot ${m.from_slot_id}` : m.from_id);
    const role = sender?.role ? ` (${sender.role})` : "";
    const idTag = name !== m.from_id && !isOrchestrator(m.from_id) ? ` [id ${m.from_id}]` : "";
    return `[${m.msg_type}] ${name}${role}${idTag}: ${m.text}`;
  }).join("\n\n---\n\n");
}

function isOrchestrator(peerId: string): boolean {
  return peerId === "orchestrator" || peerId === "__orchestrator__";
}

export function buildForwardingPrompt(formatted: string): string {
  return `[Teammate messages]\n${formatted}\n\nReply with send_message where a reply is expected, then continue your current task.`;
}

/** Deliver whatever is pending for `slotId` through its driver. */
export async function deliverPendingMessages(
  sessionId: string,
  slotId: number,
  state: DriverSlot,
  brokerClient: BrokerClient,
): Promise<DeliveryOutcome> {
  if (!state.driver.alive) return "dead";
  const threadId = state.kind === "codex" ? (state.threadId ?? state.driver.threadId) : null;
  if (state.kind === "codex" && !threadId) return "not_ready";
  if (state.busy) return "busy";

  const poll = await brokerClient.pollBySlot(slotId, { retain: true });
  const messages = poll.messages ?? [];
  if (messages.length === 0) return "none";

  const prompt = buildForwardingPrompt(formatForwardedMessages(messages, await senderMap(sessionId, brokerClient)));
  const ids = messages.map((m) => m.id);
  log(LOG_PREFIX, `Forwarding ${messages.length} message(s) to ${state.kind} slot ${slotId}`);

  if (state.kind === "claude") {
    // Claude Code queues stdin messages and reads them at the next tool-call
    // boundary; it echoes a message only then, so the echo is not awaited here —
    // waiting for it would re-send messages during long tool calls.
    try {
      await state.driver.send(prompt, { awaitEcho: false });
    } catch (err) {
      log(LOG_PREFIX, `Claude slot ${slotId} send failed: ${err instanceof Error ? err.message : String(err)}`);
      return "failed";
    }
    await ack(brokerClient, ids);
    return "sent";
  }

  if (state.driver.activeTurnId) {
    try {
      await state.driver.steer(threadId!, prompt);
    } catch (err) {
      log(LOG_PREFIX, `Steer failed for slot ${slotId} (will retry): ${err instanceof Error ? err.message : String(err)}`);
      return "failed";
    }
    await ack(brokerClient, ids);
    return "steered";
  }

  state.busy = true;
  state.driver.reply(threadId!, prompt)
    .then(async (result) => {
      state.threadId = result.threadId;
      await ack(brokerClient, ids);
      await brokerClient.updateSlot({
        id: slotId,
        context_patch: {
          codex_thread_id: result.threadId,
          last_summary: result.content.slice(0, 200),
          last_status: "working",
          updated_at: Date.now(),
        },
      }).catch(() => {});
    })
    .catch((err) => {
      log(LOG_PREFIX, `Forwarding turn failed for slot ${slotId} (messages stay unacked): ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => {
      state.busy = false;
    });
  return "replied";
}

async function ack(brokerClient: BrokerClient, ids: number[]): Promise<void> {
  try {
    await brokerClient.ackMessages(ids);
  } catch (err) {
    log(LOG_PREFIX, `Ack failed for ${ids.length} message(s): ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function senderMap(sessionId: string, brokerClient: BrokerClient): Promise<Map<number, SenderInfo>> {
  try {
    const slots = await brokerClient.listSlots(sessionId);
    return new Map(slots.map((s) => [s.id, { display_name: s.display_name, role: s.role }]));
  } catch {
    return new Map();
  }
}
