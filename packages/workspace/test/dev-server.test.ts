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
  it("wraps a callback failure under the server name and passes a StartupError through", () => {
    const err = toCallbackStartupError("docker", new Error("compose failed"));
    expect(err).toBeInstanceOf(StartupError);
    expect(err).toMatchObject({ label: "docker", reason: "compose failed", logFile: undefined });
    const original = new StartupError("docker", "compose failed", "/tmp/docker.log");
    expect(toCallbackStartupError("api", original)).toBe(original);
  });
});
