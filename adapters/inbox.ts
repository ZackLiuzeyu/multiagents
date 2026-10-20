import * as fs from "node:fs";
import * as path from "node:path";
import type { BufferedMessage } from "../shared/types.ts";

/**
 * File-based inbox (<cwd>/.multiagents/inbox/<name>.md) for hosts that can read
 * files but cannot receive pushed MCP notifications (Codex, Gemini).
 */
export class FileInbox {
  private inboxPath: string | null = null;

  constructor(private readonly cwd: string) {}

  get path(): string | null { return this.inboxPath; }

  /** Create the inbox file for `name` once; returns null if the directory cannot be created. */
  ensure(name: string | null): string | null {
    if (this.inboxPath) return this.inboxPath;
    if (!name) return null;

    const inboxDir = path.join(this.cwd, ".multiagents", "inbox");
    try {
      if (!fs.existsSync(inboxDir)) fs.mkdirSync(inboxDir, { recursive: true });
    } catch {
      return null;
    }

    // Sanitize name to prevent path traversal (e.g. "../../etc/passwd")
    const safeName = path.basename(name).replace(/[^a-zA-Z0-9_\-. ]/g, "_");
    this.inboxPath = path.join(inboxDir, `${safeName}.md`);
    try {
      fs.writeFileSync(this.inboxPath, `# Inbox for ${name}\n\nMessages from teammates appear below. Newest at bottom.\n\n---\n\n`);
    } catch { /* best effort */ }
    return this.inboxPath;
  }

  append(name: string | null, msg: BufferedMessage): void {
    const inboxPath = this.ensure(name);
    if (!inboxPath) return;
    try {
      const timestamp = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
      const from = msg.from_display_name ?? msg.from_role ?? msg.from_id;
      fs.appendFileSync(inboxPath, `**[${timestamp}] ${from}** (${msg.msg_type}):\n${msg.text}\n\n---\n\n`);
    } catch { /* best effort */ }
  }
}
