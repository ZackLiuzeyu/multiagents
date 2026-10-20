/**
 * One broker port for every component: MULTIAGENTS_PORT when it is a valid
 * port, the default otherwise — so an override can never split the system.
 */

import { test, expect, describe } from "bun:test";
import { resolveBrokerPort, brokerUrl } from "../shared/broker-url.ts";
import { DEFAULT_BROKER_PORT } from "../shared/constants.ts";

describe("resolveBrokerPort", () => {
  test("defaults when MULTIAGENTS_PORT is unset or blank", () => {
    expect(resolveBrokerPort({})).toBe(DEFAULT_BROKER_PORT);
    expect(resolveBrokerPort({ MULTIAGENTS_PORT: "" })).toBe(DEFAULT_BROKER_PORT);
    expect(resolveBrokerPort({ MULTIAGENTS_PORT: "   " })).toBe(DEFAULT_BROKER_PORT);
  });

  test("uses a valid override", () => {
    expect(resolveBrokerPort({ MULTIAGENTS_PORT: "17999" })).toBe(17999);
    expect(resolveBrokerPort({ MULTIAGENTS_PORT: " 17999 " })).toBe(17999);
    expect(brokerUrl({ MULTIAGENTS_PORT: "17999" })).toBe("http://127.0.0.1:17999");
  });

  test("falls back to the default on an invalid value and says so on stderr", () => {
    const warnings: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      for (const bad of ["abc", "0", "65536", "12.5", "-1", "7899abc"]) {
        expect(resolveBrokerPort({ MULTIAGENTS_PORT: bad })).toBe(DEFAULT_BROKER_PORT);
      }
    } finally {
      console.error = original;
    }
    expect(warnings).toHaveLength(6);
    expect(warnings[0]).toContain("MULTIAGENTS_PORT");
  });

  test("reads the process environment by default", () => {
    const previous = process.env.MULTIAGENTS_PORT;
    process.env.MULTIAGENTS_PORT = "18001";
    try {
      expect(resolveBrokerPort()).toBe(18001);
      expect(brokerUrl()).toBe("http://127.0.0.1:18001");
    } finally {
      if (previous === undefined) delete process.env.MULTIAGENTS_PORT; else process.env.MULTIAGENTS_PORT = previous;
    }
  });
});
