import { describe, expect, it } from "vitest";
import { createIdleTimeout } from "../src/routes/idle-timeout.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("createIdleTimeout", () => {
  it("aborts after idleMs of inactivity", async () => {
    const idle = createIdleTimeout(20);
    expect(idle.signal.aborted).toBe(false);
    await sleep(45);
    expect(idle.signal.aborted).toBe(true);
    expect(idle.abortedByIdle).toBe(true);
    idle.dispose();
  });

  it("reset() postpones the abort", async () => {
    const idle = createIdleTimeout(40);
    await sleep(25);
    idle.reset();
    await sleep(25);
    expect(idle.signal.aborted).toBe(false);
    await sleep(30);
    expect(idle.signal.aborted).toBe(true);
    idle.dispose();
  });

  it("dispose() prevents any abort", async () => {
    const idle = createIdleTimeout(20);
    idle.dispose();
    await sleep(45);
    expect(idle.signal.aborted).toBe(false);
  });

  it("abort() aborts immediately without marking abortedByIdle", () => {
    const idle = createIdleTimeout(1000);
    idle.abort();
    expect(idle.signal.aborted).toBe(true);
    expect(idle.abortedByIdle).toBe(false);
    idle.dispose();
  });

  it("reset() after abort is a no-op", async () => {
    const idle = createIdleTimeout(15);
    await sleep(35);
    expect(idle.signal.aborted).toBe(true);
    idle.reset();
    await sleep(20);
    expect(idle.signal.aborted).toBe(true);
    idle.dispose();
  });
});
