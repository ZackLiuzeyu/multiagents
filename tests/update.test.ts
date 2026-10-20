/**
 * `multiagents update` — finds out how this copy was installed, compares it
 * with the registry, runs the matching upgrade, and restarts an idle broker so
 * the next start runs the new code. Every external effect is injected.
 */

import { test, expect, describe } from "bun:test";
import { detectInstall, upgradeCommand, runUpdate, listeningPids, parseBrokerHealth, stopBrokerProcess, probeBrokerHealth, type UpdateDeps } from "../cli/update.ts";

const BUN_ROOT = "/Users/me/.bun/install/global/node_modules/multiagents";
const NPM_ROOT = "/usr/local/lib/node_modules/multiagents";

function fakeDeps(overrides: Partial<UpdateDeps> = {}) {
  const log: string[] = [];
  const runs: string[][] = [];
  let stopped = 0;
  const deps: UpdateDeps = {
    packageRoot: BUN_ROOT,
    installedVersion: "0.5.0",
    env: {},
    exists: () => false,
    fetchLatestVersion: async () => "0.6.0",
    run: async (cmd) => { runs.push(cmd); return 0; },
    brokerHealth: async () => null,
    stopBroker: async () => { stopped++; },
    log: (line) => { log.push(line); },
    ...overrides,
  };
  return { deps, log, runs, stopped: () => stopped };
}

describe("detectInstall", () => {
  test("a copy under Bun's global install directory is a bun install", () => {
    expect(detectInstall(BUN_ROOT, { env: {}, exists: () => false })).toBe("bun");
    expect(detectInstall("/opt/bun/install/global/node_modules/multiagents", { env: { BUN_INSTALL: "/opt/bun" }, exists: () => false })).toBe("bun");
  });

  test("a copy under an npm global prefix is an npm install", () => {
    expect(detectInstall(NPM_ROOT, { env: {}, exists: () => false })).toBe("npm");
    expect(detectInstall("/Users/me/.nvm/versions/node/v24.0.0/lib/node_modules/multiagents", { env: {}, exists: () => false })).toBe("npm");
    expect(detectInstall("/opt/homebrew/lib/node_modules/multiagents", { env: {}, exists: () => false })).toBe("npm");
    expect(detectInstall("C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\multiagents", { env: {}, exists: () => false })).toBe("npm");
  });

  test("a project's own node_modules copy is a local dependency, not a global install", () => {
    expect(detectInstall("/Users/me/project/node_modules/multiagents", { env: {}, exists: () => false })).toBe("local");
  });

  test("a copy with a .git directory is a source checkout", () => {
    expect(detectInstall("/Users/me/Documents/multiagents", { env: {}, exists: (p) => p.endsWith("/.git") })).toBe("source");
  });

  test("pnpm and yarn global installs are recognised so npm does not get a stray second copy", () => {
    expect(detectInstall("/Users/me/Library/pnpm/global/5/node_modules/multiagents", { env: {}, exists: () => false })).toBe("pnpm");
    expect(detectInstall("/Users/me/.config/yarn/global/node_modules/multiagents", { env: {}, exists: () => false })).toBe("yarn");
  });

  test("anything else is unknown", () => {
    expect(detectInstall("/srv/tools/multiagents", { env: {}, exists: () => false })).toBe("unknown");
  });
});

describe("upgradeCommand", () => {
  test("uses the package manager that owns the install", () => {
    expect(upgradeCommand("bun", "0.6.0")).toEqual(["bun", "add", "-g", "multiagents@0.6.0"]);
    expect(upgradeCommand("npm", "0.6.0")).toEqual(["npm", "install", "-g", "multiagents@0.6.0"]);
    expect(upgradeCommand("pnpm", "0.6.0")).toEqual(["pnpm", "add", "-g", "multiagents@0.6.0"]);
    expect(upgradeCommand("yarn", "0.6.0")).toEqual(["yarn", "global", "add", "multiagents@0.6.0"]);
  });
});

describe("parseBrokerHealth", () => {
  test("accepts only the broker's own health shape", () => {
    expect(parseBrokerHealth({ status: "ok", peers: 3 })).toEqual({ peers: 3 });
    expect(parseBrokerHealth({ status: "ok", peers: 0, pid: 4242, version: "0.6.0" })).toEqual({ peers: 0, pid: 4242, version: "0.6.0" });
    expect(parseBrokerHealth({ status: "ok" })).toBeNull();
    expect(parseBrokerHealth({ ok: true, peers: 1 })).toBeNull();
    expect(parseBrokerHealth({ status: "ok", peers: "3" })).toBeNull();
    expect(parseBrokerHealth("ok")).toBeNull();
    expect(parseBrokerHealth(null)).toBeNull();
  });
});

describe("stopBrokerProcess", () => {
  test("reports null when lsof is not available instead of throwing", () => {
    expect(listeningPids(17909, { lsof: "definitely-not-installed-xyz" })).toBeNull();
  });

  test("stops the pid the broker reported without needing lsof", async () => {
    const victim = Bun.spawn(["sleep", "600"], { stdout: "ignore", stderr: "ignore" });
    const stopped = stopBrokerProcess({ peers: 0, pid: victim.pid }, 17909, { lsof: "definitely-not-installed-xyz" });
    expect(stopped).toEqual([victim.pid]);
    const ended = await Promise.race([victim.exited.then(() => true), Bun.sleep(3000).then(() => false)]);
    expect(ended).toBe(true);
  });

  test("without a reported pid and without lsof it says what to do instead of guessing", () => {
    expect(() => stopBrokerProcess({ peers: 0 }, 17909, { lsof: "definitely-not-installed-xyz" })).toThrow(/lsof/);
  });
});

describe("probeBrokerHealth", () => {
  test("gives up on a broker that accepts the connection but never answers", async () => {
    const port = 17912;
    const server = Bun.serve({ port, fetch: () => new Promise<Response>(() => {}) });
    try {
      const started = Date.now();
      expect(await probeBrokerHealth(`http://127.0.0.1:${port}`, 500)).toBeNull();
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      server.stop(true);
    }
  });

  test("reads a healthy broker", async () => {
    const port = 17913;
    const server = Bun.serve({ port, fetch: () => Response.json({ status: "ok", peers: 1, pid: 4242, version: "0.6.0" }) });
    try {
      expect(await probeBrokerHealth(`http://127.0.0.1:${port}`, 2000)).toEqual({ peers: 1, pid: 4242, version: "0.6.0" });
    } finally {
      server.stop(true);
    }
  });

  test("treats a closed port as no broker", async () => {
    expect(await probeBrokerHealth("http://127.0.0.1:17914", 2000)).toBeNull();
  });
});

describe("listeningPids", () => {
  test.skipIf(!Bun.which("lsof"))("names only the process listening on the port, never clients connected to it", async () => {
    const port = 17909;
    const server = Bun.spawn(["bun", "-e", `Bun.serve({ port: ${port}, fetch: () => new Response("ok") })`], { stdout: "ignore", stderr: "ignore" });
    let client: { end: () => void } | null = null;
    try {
      for (let i = 0; i < 50; i++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break; } catch { /* not up yet */ }
        await Bun.sleep(100);
      }
      client = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
      const pids = listeningPids(port);
      expect(pids).toEqual([String(server.pid)]);
      expect(pids).not.toContain(String(process.pid));
    } finally {
      client?.end();
      server.kill();
    }
  }, 15_000);
});

describe("runUpdate", () => {
  test("upgrades a bun install to the registry's latest version", async () => {
    const { deps, runs, log } = fakeDeps();
    const result = await runUpdate([], deps);
    expect(runs).toEqual([["bun", "add", "-g", "multiagents@0.6.0"]]);
    expect(result).toMatchObject({ ok: true, action: "updated", kind: "bun", installed: "0.5.0", latest: "0.6.0" });
    expect(log.join("\n")).toContain("0.5.0 → 0.6.0");
  });

  test("upgrades an npm install with npm", async () => {
    const { deps, runs } = fakeDeps({ packageRoot: NPM_ROOT });
    const result = await runUpdate([], deps);
    expect(runs).toEqual([["npm", "install", "-g", "multiagents@0.6.0"]]);
    expect(result.kind).toBe("npm");
  });

  test("does nothing when already on the latest version", async () => {
    const { deps, runs, log } = fakeDeps({ installedVersion: "0.6.0" });
    const result = await runUpdate([], deps);
    expect(runs).toEqual([]);
    expect(result).toMatchObject({ ok: true, action: "up-to-date" });
    expect(log.join("\n")).toContain("0.6.0");
  });

  test("an installed version newer than the registry's latest is left alone", async () => {
    const { deps, runs, log } = fakeDeps({ installedVersion: "0.7.0" });
    const result = await runUpdate([], deps);
    expect(runs).toEqual([]);
    expect(result).toMatchObject({ ok: true, action: "up-to-date", installed: "0.7.0", latest: "0.6.0" });
    expect(log.join("\n")).toMatch(/newer/i);
  });

  test("--check also works from a source checkout", async () => {
    const { deps, runs } = fakeDeps({ packageRoot: "/Users/me/Documents/multiagents", exists: (p) => p.endsWith("/.git") });
    const result = await runUpdate(["--check"], deps);
    expect(runs).toEqual([]);
    expect(result).toMatchObject({ ok: true, action: "check", kind: "source", installed: "0.5.0", latest: "0.6.0" });
  });

  test("a package manager that cannot be started is reported, not thrown", async () => {
    const { deps, log, stopped } = fakeDeps({ run: () => { throw new Error("ENOENT: bun not found"); }, brokerHealth: async () => ({ peers: 0 }) });
    const result = await runUpdate([], deps);
    expect(result).toMatchObject({ ok: false, action: "failed" });
    expect(log.join("\n")).toContain("ENOENT");
    expect(stopped()).toBe(0);
  });

  test("--check only reports the versions", async () => {
    const { deps, runs, log } = fakeDeps();
    const result = await runUpdate(["--check"], deps);
    expect(runs).toEqual([]);
    expect(result).toMatchObject({ ok: true, action: "check", installed: "0.5.0", latest: "0.6.0" });
    expect(log.join("\n")).toMatch(/installed.*0\.5\.0/i);
    expect(log.join("\n")).toMatch(/latest.*0\.6\.0/i);
  });

  test("--dry-run prints the command without running it", async () => {
    const { deps, runs, log } = fakeDeps();
    const result = await runUpdate(["--dry-run"], deps);
    expect(runs).toEqual([]);
    expect(result).toMatchObject({ ok: true, action: "dry-run", command: ["bun", "add", "-g", "multiagents@0.6.0"] });
    expect(log.join("\n")).toContain("bun add -g multiagents@0.6.0");
  });

  test("a source checkout is not upgraded through a package manager", async () => {
    const { deps, runs, log } = fakeDeps({ packageRoot: "/Users/me/Documents/multiagents", exists: (p) => p.endsWith("/.git") });
    const result = await runUpdate([], deps);
    expect(runs).toEqual([]);
    expect(result).toMatchObject({ ok: true, action: "source-checkout", kind: "source" });
    expect(log.join("\n")).toContain("git pull");
  });

  test("a local dependency is not upgraded globally", async () => {
    const { deps, runs, log } = fakeDeps({ packageRoot: "/Users/me/project/node_modules/multiagents" });
    const result = await runUpdate([], deps);
    expect(runs).toEqual([]);
    expect(result).toMatchObject({ ok: true, action: "local-dependency", kind: "local" });
    expect(log.join("\n")).toContain("bun update multiagents");
    expect(log.join("\n")).toContain("npm update multiagents");
  });

  test("--check also works from a local dependency", async () => {
    const { deps, runs } = fakeDeps({ packageRoot: "/Users/me/project/node_modules/multiagents" });
    const result = await runUpdate(["--check"], deps);
    expect(runs).toEqual([]);
    expect(result).toMatchObject({ ok: true, action: "check", kind: "local", latest: "0.6.0" });
  });

  test("an unknown install location gets both commands instead of a guess", async () => {
    const { deps, runs, log } = fakeDeps({ packageRoot: "/srv/tools/multiagents" });
    const result = await runUpdate([], deps);
    expect(runs).toEqual([]);
    expect(result).toMatchObject({ ok: false, action: "unknown-install" });
    expect(log.join("\n")).toContain("bun add -g multiagents@0.6.0");
    expect(log.join("\n")).toContain("npm install -g multiagents@0.6.0");
  });

  test("a registry failure stops before anything is run", async () => {
    const { deps, runs, log } = fakeDeps({ fetchLatestVersion: async () => { throw new Error("ENOTFOUND registry.npmjs.org"); } });
    const result = await runUpdate([], deps);
    expect(runs).toEqual([]);
    expect(result).toMatchObject({ ok: false, action: "failed" });
    expect(log.join("\n")).toContain("ENOTFOUND");
  });

  test("a failed upgrade is reported and leaves the broker alone", async () => {
    const { deps, stopped } = fakeDeps({ run: async () => 1, brokerHealth: async () => ({ peers: 0 }) });
    const result = await runUpdate([], deps);
    expect(result).toMatchObject({ ok: false, action: "failed" });
    expect(stopped()).toBe(0);
  });

  test("after an upgrade an idle broker is stopped so the next start runs the new code", async () => {
    const { deps, stopped, log } = fakeDeps({ brokerHealth: async () => ({ peers: 0 }) });
    const result = await runUpdate([], deps);
    expect(stopped()).toBe(1);
    expect(result.brokerRestarted).toBe(true);
    expect(log.join("\n")).toMatch(/broker/i);
  });

  test("a broker with registered agents is left running, with a warning", async () => {
    const { deps, stopped, log } = fakeDeps({ brokerHealth: async () => ({ peers: 2 }) });
    const result = await runUpdate([], deps);
    expect(stopped()).toBe(0);
    expect(result.brokerRestarted).toBe(false);
    expect(log.join("\n")).toMatch(/2 agent/);
    expect(log.join("\n")).toContain("multiagents broker stop");
  });

  test("a broker that cannot be stopped does not fail the update", async () => {
    const { deps, log } = fakeDeps({ brokerHealth: async () => ({ peers: 0 }), stopBroker: async () => { throw new Error("lsof is not installed"); } });
    const result = await runUpdate([], deps);
    expect(result).toMatchObject({ ok: true, action: "updated", brokerRestarted: false });
    expect(log.join("\n")).toContain("lsof is not installed");
    expect(log.join("\n")).toContain("multiagents broker stop");
  });

  test("the warning names the version the broker itself reports", async () => {
    const { deps, log } = fakeDeps({ brokerHealth: async () => ({ peers: 2, version: "0.4.0" }) });
    await runUpdate([], deps);
    expect(log.join("\n")).toMatch(/broker.*0\.4\.0/);
  });

  test("the result mentions that open sessions keep the old code until restarted", async () => {
    const { deps, log } = fakeDeps();
    await runUpdate([], deps);
    expect(log.join("\n")).toMatch(/restart/i);
  });
});
