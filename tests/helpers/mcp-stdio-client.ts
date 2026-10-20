import type { Subprocess } from "bun";
import * as fs from "node:fs";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

async function drainStderr(proc: Subprocess<"pipe", "pipe", "pipe">, logPath?: string): Promise<void> {
  const reader = proc.stderr.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (logPath) fs.appendFileSync(logPath, Buffer.from(value));
    }
  } catch { /* process gone */ }
}

/**
 * Minimal MCP client over stdio for driving a real adapter process in tests
 * (initialize → tools/call), recording server-initiated notifications.
 */
export class McpStdioClient {
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";

  private constructor(readonly proc: Subprocess<"pipe", "pipe", "pipe">) {
    this.readLoop();
  }

  /** `stderrLog` keeps the server's stderr in a file; it is always drained so a chatty server cannot block on a full pipe. */
  static async spawn(cmd: string[], opts: { cwd: string; env: Record<string, string | undefined>; stderrLog?: string }): Promise<McpStdioClient> {
    const proc = Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    void drainStderr(proc, opts.stderrLog);
    const client = new McpStdioClient(proc);
    await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcp-stdio-test-client", version: "0" },
    }, 20_000);
    client.notify("notifications/initialized", {});
    return client;
  }

  get pid(): number { return this.proc.pid; }

  async callTool(name: string, args: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<{ text: string; isError: boolean }> {
    const result = await this.request("tools/call", { name, arguments: args }, timeoutMs) as { content: { type: string; text: string }[]; isError?: boolean };
    return { text: result.content.map((c) => c.text).join("\n"), isError: result.isError === true };
  }

  request(method: string, params: unknown, timeoutMs = 10_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  closeStdin(): void {
    this.proc.stdin.end();
  }

  kill(): void {
    try { this.proc.kill(); } catch { /* already dead */ }
  }

  private write(msg: unknown): void {
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
    this.proc.stdin.flush();
  }

  private async readLoop(): Promise<void> {
    const reader = this.proc.stdout.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      this.buffer += decoder.decode(value, { stream: true });
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && msg.id !== null && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
          else p.resolve(msg.result);
        } else if (msg.method) {
          this.notifications.push({ method: msg.method, params: msg.params });
        }
      }
    }
  }
}
