import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { toCallbackStartupError, watchForExternalStop } from "../src/dev-server.js";
import { StartupError } from "../src/errors.js";

describe("watchForExternalStop", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires once all watched pids are dead", () => {
    const alive = new Set([10, 20]);
    const onStopped = vi.fn();
    watchForExternalStop([10, 20], onStopped, (pid) => alive.has(pid), 100);

    vi.advanceTimersByTime(100);
    expect(onStopped).not.toHaveBeenCalled();

    alive.delete(10);
    vi.advanceTimersByTime(100);
    expect(onStopped).not.toHaveBeenCalled();

    alive.delete(20);
    vi.advanceTimersByTime(100);
    expect(onStopped).toHaveBeenCalledTimes(1);
  });

  it("stops polling after firing", () => {
    const onStopped = vi.fn();
    watchForExternalStop([10], onStopped, () => false, 100);
    vi.advanceTimersByTime(300);
    expect(onStopped).toHaveBeenCalledTimes(1);
  });

  it("no-ops with no pids", () => {
    const onStopped = vi.fn();
    const timer = watchForExternalStop([], onStopped, () => true, 100);
    vi.advanceTimersByTime(1000);
    expect(onStopped).not.toHaveBeenCalled();
    expect(timer).toBeUndefined();
  });
});

describe("toCallbackStartupError", () => {
  it("wraps an Error's message under the server name", () => {
    const err = toCallbackStartupError("docker", new Error("compose failed"));
    expect(err).toBeInstanceOf(StartupError);
    expect(err.label).toBe("docker");
    expect(err.reason).toBe("compose failed");
    expect(err.logFile).toBeUndefined();
  });

  it("stringifies a non-Error throw", () => {
    expect(toCallbackStartupError("docker", "boom").reason).toBe("boom");
  });

  it("passes an existing StartupError through unchanged", () => {
    const original = new StartupError("docker", "compose failed", "/tmp/docker.log");
    const err = toCallbackStartupError("api", original);
    expect(err).toBe(original);
    expect(err.reason).toBe("compose failed");
    expect(err.logFile).toBe("/tmp/docker.log");
  });
});
