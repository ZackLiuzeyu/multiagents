// ============================================================================
// multiagents — Claude Code Driver
// ============================================================================
// Runs one long-lived headless Claude Code session
//   claude -p --input-format stream-json --output-format stream-json ...
// and feeds it user messages over stdin. A message written while a turn is
// running is read by Claude in that same turn as soon as the running tool
// call finishes (stream-json default priority), which is the only delivery
// path that reaches a headless session: channel notifications are dropped
// under `-p`.
//
// Events parsed from stdout (one JSON object per line), as observed on
// Claude Code 2.1.241:
//   system/init        → session id, MCP server status; emitted only after
//                        the FIRST user message arrives, so the driver sends
//                        before it waits for init
//   user, isReplay     → echo of a message we sent (--replay-user-messages)
//   assistant          → activity
//   result             → turn finished (usage, cost, subtype)
// Closing stdin ends the session cleanly (exit code 0).
// ============================================================================

import type { Subprocess } from "bun";
import { log } from "../shared/utils.ts";

type PipedSubprocess = Subprocess<"pipe", "pipe", "pipe">;

const LOG_PREFIX = "claude-driver";

export interface ClaudeLaunchOptions {
  /** Inline MCP config for `--mcp-config` (loaded with `--strict-mcp-config`). */
  mcpConfig: Record<string, unknown>;
  appendSystemPrompt?: string;
  model?: string;
  maxTurns?: number;
  /** Resume a previous session instead of starting a fresh one. */
  resumeSessionId?: string;
}

export interface ClaudeDriverOptions extends ClaudeLaunchOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  /** Command to run instead of `claude` (tests use a fake). */
  command?: string[];
  /** How long the first message may take to produce the init event. */
  initTimeoutMs?: number;
  /** Sent right after spawning; `spawn` then resolves once the session reports init. */
  firstPrompt?: string;
}

export interface ClaudeTurnResult {
  content: string;
  subtype: string;
  isError: boolean;
  numTurns: number;
  costUsd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
}

export type ClaudeEvent = { type: string; [key: string]: unknown };
export type ClaudeEventListener = (event: ClaudeEvent) => void;

export function buildClaudeArgs(opts: ClaudeLaunchOptions): string[] {
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--replay-user-messages",
    "--dangerously-skip-permissions",
    "--strict-mcp-config",
    "--mcp-config", JSON.stringify(opts.mcpConfig),
  ];
  if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
  if (opts.model) args.push("--model", opts.model);
  if (opts.maxTurns) args.push("--max-turns", String(opts.maxTurns));
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  return args;
}

function defaultCommand(): string[] {
  const override = process.env.MULTIAGENTS_CLAUDE_COMMAND?.trim();
  if (override) return override.split(/\s+/);
  return ["claude"];
}

function textOf(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => (block as { text?: string }).text ?? "").join("");
  }
  return "";
}

function hasToolResult(message: unknown): boolean {
  const content = (message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) && content.some((block) => (block as { type?: string }).type === "tool_result");
}

export class ClaudeDriver {
  private proc: PipedSubprocess;
  private readonly initTimeoutMs: number;
  private buffer = "";
  private _alive = true;
  private _sessionId: string | null = null;
  private _mcpServers: Array<{ name: string; status: string }> = [];
  private _busy = false;
  private _turnsCompleted = 0;
  private _lastActivity = Date.now();
  private _exitCode: number | null = null;
  private _onExit: Array<(code: number) => void> = [];
  private _listeners: ClaudeEventListener[] = [];
  private _initWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private _turnWaiters: Array<{ resolve: (r: ClaudeTurnResult) => void; reject: (e: Error) => void }> = [];
  /** Texts we wrote to stdin that the host has not echoed back yet (FIFO). */
  private _awaitingEcho: Array<{ text: string; resolve: () => void }> = [];

  get alive(): boolean { return this._alive; }
  get pid(): number { return this.proc.pid; }
  get process(): PipedSubprocess { return this.proc; }
  get sessionId(): string | null { return this._sessionId; }
  get mcpServers(): Array<{ name: string; status: string }> { return this._mcpServers; }
  /** True from the first message of a turn until its result event. */
  get busy(): boolean { return this._busy; }
  get turnsCompleted(): number { return this._turnsCompleted; }
  get lastActivity(): number { return this._lastActivity; }
  get exitCode(): number | null { return this._exitCode; }

  private constructor(proc: PipedSubprocess, initTimeoutMs: number) {
    this.proc = proc;
    this.initTimeoutMs = initTimeoutMs;
    this.readStdout();
    this.readStderr();
    this.proc.exited.then((code) => {
      this._alive = false;
      this._busy = false;
      this._exitCode = code;
      log(LOG_PREFIX, `claude exited with code ${code}`);
      const err = new Error(`claude exited (code ${code})${this._turnWaiters.length > 0 ? " during a turn" : ""}`);
      this._initWaiter?.reject(err);
      this._initWaiter = null;
      for (const w of this._turnWaiters.splice(0)) w.reject(err);
      for (const e of this._awaitingEcho.splice(0)) e.resolve();
      for (const cb of this._onExit) {
        try { cb(code); } catch { /* keep going */ }
      }
    });
  }

  onExit(cb: (code: number) => void): void { this._onExit.push(cb); }
  onEvent(cb: ClaudeEventListener): void { this._listeners.push(cb); }

  /**
   * Spawn the session. With `firstPrompt`, the prompt is written immediately
   * and this resolves once Claude reports init (it only does so after the
   * first message); without it, init is awaited by the first `send()`.
   */
  static async spawn(opts: ClaudeDriverOptions): Promise<ClaudeDriver> {
    const args = buildClaudeArgs(opts);
    const command = opts.command ?? defaultCommand();
    const proc = Bun.spawn([...command, ...args], {
      cwd: opts.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: opts.env,
    });
    const driver = new ClaudeDriver(proc, opts.initTimeoutMs ?? 90_000);
    if (opts.firstPrompt !== undefined) {
      await driver.send(opts.firstPrompt);
      log(LOG_PREFIX, `Session ${driver.sessionId} ready (pid ${proc.pid}, mcp: ${driver.mcpServers.map((s) => `${s.name}=${s.status}`).join(",") || "none"})`);
    }
    return driver;
  }

  private waitForInit(): Promise<void> {
    if (this._sessionId) return Promise.resolve();
    if (this._initWaiter) return Promise.reject(new Error("init is already being awaited by another send()"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._initWaiter = null;
        void this.kill();
        reject(new Error(`claude did not emit its init event within ${this.initTimeoutMs}ms`));
      }, this.initTimeoutMs);
      this._initWaiter = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
    });
  }

  /**
   * Write a user message. Resolves true once the host echoed it back (the
   * message is in Claude's queue), false if no echo arrived within the grace
   * period. The first message also waits for the session's init event.
   * Throws if the process is gone or never initializes.
   */
  async send(text: string, opts: { priority?: "next" | "later" | "now"; echoTimeoutMs?: number } = {}): Promise<boolean> {
    if (!this._alive) throw new Error("claude is not alive");
    const message: Record<string, unknown> = { type: "user", message: { role: "user", content: text } };
    if (opts.priority) message.priority = opts.priority;

    let settle!: (echoed: boolean) => void;
    const echoed = new Promise<boolean>((resolve) => { settle = resolve; });
    const entry = { text, resolve: () => settle(true) };
    this._awaitingEcho.push(entry);

    this.proc.stdin.write(JSON.stringify(message) + "\n");
    this.proc.stdin.flush();
    this._busy = true;
    this._lastActivity = Date.now();

    if (!this._sessionId) await this.waitForInit();

    setTimeout(() => {
      const idx = this._awaitingEcho.indexOf(entry);
      if (idx !== -1) {
        this._awaitingEcho.splice(idx, 1);
        settle(false);
      }
    }, opts.echoTimeoutMs ?? 10_000);
    return echoed;
  }

  /** Resolves with the next result event. */
  waitForTurn(timeoutMs = 10 * 60_000): Promise<ClaudeTurnResult> {
    if (!this._alive) return Promise.reject(new Error(`claude exited (code ${this._exitCode})`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this._turnWaiters.indexOf(waiter);
        if (idx !== -1) this._turnWaiters.splice(idx, 1);
        reject(new Error(`No result event within ${timeoutMs}ms`));
      }, timeoutMs);
      const waiter = {
        resolve: (r: ClaudeTurnResult) => { clearTimeout(timer); resolve(r); },
        reject: (e: Error) => { clearTimeout(timer); reject(e); },
      };
      this._turnWaiters.push(waiter);
    });
  }

  /** Send a message and wait for the turn it starts (or joins) to finish. */
  async prompt(text: string, timeoutMs?: number): Promise<ClaudeTurnResult> {
    const result = this.waitForTurn(timeoutMs);
    result.catch(() => { /* surfaced through the awaited promise below */ });
    await this.send(text);
    return result;
  }

  /** End stdin so Claude finishes its current turn and exits; escalates to SIGTERM/SIGKILL. */
  async close(timeoutMs = 15_000): Promise<number> {
    if (!this._alive) return this._exitCode ?? -1;
    try { this.proc.stdin.end(); } catch { /* already closed */ }
    const exited = await Promise.race([this.proc.exited, Bun.sleep(timeoutMs).then(() => null)]);
    if (exited !== null) return exited;
    log(LOG_PREFIX, `claude did not exit ${timeoutMs}ms after stdin closed — sending SIGTERM`);
    try { this.proc.kill("SIGTERM"); } catch { /* gone */ }
    const afterTerm = await Promise.race([this.proc.exited, Bun.sleep(3_000).then(() => null)]);
    if (afterTerm !== null) return afterTerm;
    try { this.proc.kill("SIGKILL"); } catch { /* gone */ }
    return this.proc.exited;
  }

  async kill(): Promise<void> {
    if (!this._alive) return;
    try { this.proc.kill("SIGTERM"); } catch { /* already dead */ }
    const exited = await Promise.race([this.proc.exited, Bun.sleep(3_000).then(() => null)]);
    if (exited === null) {
      try { this.proc.kill("SIGKILL"); } catch { /* gone */ }
    }
  }

  // --- stdout events ---

  private handleEvent(event: ClaudeEvent): void {
    this._lastActivity = Date.now();
    for (const listener of this._listeners) {
      try { listener(event); } catch { /* listener errors must not break the reader */ }
    }

    switch (event.type) {
      case "system": {
        if (event.subtype === "init") {
          this._sessionId = (event.session_id as string) ?? null;
          this._mcpServers = (event.mcp_servers as Array<{ name: string; status: string }>) ?? [];
          this._initWaiter?.resolve();
          this._initWaiter = null;
        }
        return;
      }
      case "user": {
        if (event.isReplay !== true && hasToolResult(event.message)) return;
        const text = textOf(event.message);
        const idx = this._awaitingEcho.findIndex((e) => e.text === text);
        if (idx !== -1) {
          const [entry] = this._awaitingEcho.splice(idx, 1);
          entry!.resolve();
        }
        return;
      }
      case "result": {
        this._busy = false;
        this._turnsCompleted++;
        const usage = event.usage as ClaudeTurnResult["usage"] | undefined;
        const result: ClaudeTurnResult = {
          content: typeof event.result === "string" ? event.result : "",
          subtype: (event.subtype as string) ?? "unknown",
          isError: event.is_error === true,
          numTurns: (event.num_turns as number) ?? 0,
          costUsd: event.total_cost_usd as number | undefined,
          usage: usage ? {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read_input_tokens: usage.cache_read_input_tokens,
          } : undefined,
        };
        for (const w of this._turnWaiters.splice(0)) w.resolve(result);
        return;
      }
    }
  }

  private async readStdout(): Promise<void> {
    const decoder = new TextDecoder();
    const reader = this.proc.stdout.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let event: ClaudeEvent;
          try { event = JSON.parse(trimmed); } catch { continue; }
          if (event && typeof event.type === "string") this.handleEvent(event);
        }
      }
    } catch (err) {
      if (this._alive) log(LOG_PREFIX, `stdout reader error: ${err}`);
    }
  }

  private async readStderr(): Promise<void> {
    const decoder = new TextDecoder();
    const reader = this.proc.stderr.getReader();
    let buf = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed && /error|fatal|exception/i.test(trimmed)) {
            log(LOG_PREFIX, `stderr: ${trimmed.slice(0, 200)}`);
          }
        }
      }
    } catch { /* ignore */ }
  }
}
