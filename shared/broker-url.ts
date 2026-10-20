import { DEFAULT_BROKER_PORT, BROKER_HOSTNAME } from "./constants.ts";

/**
 * The broker port every component agrees on: MULTIAGENTS_PORT when it is a
 * valid port, the default otherwise. An invalid value is reported and ignored
 * rather than honoured by some components and not others.
 */
export function resolveBrokerPort(env: Record<string, string | undefined> = process.env): number {
  const raw = env.MULTIAGENTS_PORT?.trim();
  if (!raw) return DEFAULT_BROKER_PORT;
  const port = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`[multiagents] Ignoring invalid MULTIAGENTS_PORT=${JSON.stringify(raw)}; using port ${DEFAULT_BROKER_PORT}`);
    return DEFAULT_BROKER_PORT;
  }
  return port;
}

export function brokerUrl(env: Record<string, string | undefined> = process.env): string {
  return `http://${BROKER_HOSTNAME}:${resolveBrokerPort(env)}`;
}
