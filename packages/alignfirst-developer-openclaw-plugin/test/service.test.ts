import type { OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ATTEMPT_SPACING_MS,
  createHandoffService,
  MAX_ATTEMPTS,
} from "../src/thread-handoff/service.js";
import { createHandoffStore } from "../src/thread-handoff/state.js";
import { handoff, temporaryStateDir } from "./helpers.js";

const dispatchTurn = vi.hoisted(() => vi.fn());

vi.mock("../src/thread-handoff/dispatch.js", () => ({ dispatchTurn }));

describe("handoff turn start and recovery", () => {
  beforeEach(() => {
    dispatchTurn.mockReset().mockResolvedValue(undefined);
  });

  it("starts Slack and Discord reply runs with exact turn requests", async () => {
    const fixture = serviceFixture();
    const slack = handoff();
    const discord = handoff({
      routeKey: "route-2",
      handoffId: "handoff-2",
      targetSessionKey: "agent:main:discord:channel:T1",
      channelId: "discord",
      accountId: undefined,
      threadId: "T1",
      deliveryContext: { channel: "discord", to: "channel:T1" },
    });
    fixture.store.insertHandoff(slack);
    fixture.store.insertHandoff(discord);

    await fixture.service.startTurn(slack);
    await fixture.service.startTurn(discord);

    expect(dispatchTurn).toHaveBeenNthCalledWith(1, {
      runtime: fixture.runtime,
      logger: fixture.logger,
      request: {
        sessionKey: slack.targetSessionKey,
        agentId: "main",
        channelId: "slack",
        surface: "slack",
        route: slack.deliveryContext,
        parentConversationId: "C1",
        message: "Take over this thread.",
        messageId: "thread-handoff:handoff-1:1",
      },
    });
    expect(dispatchTurn).toHaveBeenNthCalledWith(2, {
      runtime: fixture.runtime,
      logger: fixture.logger,
      request: {
        sessionKey: discord.targetSessionKey,
        agentId: "main",
        channelId: "discord",
        surface: "discord",
        route: discord.deliveryContext,
        parentConversationId: "C1",
        message: "Take over this thread.",
        messageId: "thread-handoff:handoff-2:1",
      },
    });
    fixture.store.close();
  });

  it("records the attempt before spawning and suppresses concurrent starts and recovery", async () => {
    const deferred = createDeferred<void>();
    const fixture = serviceFixture();
    const record = handoff();
    fixture.store.insertHandoff(record);
    dispatchTurn.mockImplementationOnce(() => {
      expect(fixture.store.findHandoffByRoute(record.routeKey)?.attemptCount).toBe(1);
      return deferred.promise;
    });

    await fixture.service.startTurn(record);
    await fixture.service.startTurn(record);
    await fixture.service.start();
    expect(dispatchTurn).toHaveBeenCalledTimes(1);
    await fixture.service.stop();
    deferred.resolve(undefined);
    await vi.waitFor(() =>
      expect(fixture.store.findHandoffByRoute(record.routeKey)?.lastAttemptedAt).toBe(100_000),
    );
    fixture.store.close();
  });

  it("logs failed attempts and records their end time", async () => {
    const times = [100_000, 101_000];
    const fixture = serviceFixture({ now: () => times.shift() ?? 101_000 });
    const record = handoff();
    fixture.store.insertHandoff(record);
    dispatchTurn.mockRejectedValueOnce(new Error("dispatch refused"));

    await fixture.service.startTurn(record);
    await vi.waitFor(() =>
      expect(fixture.store.findHandoffByRoute(record.routeKey)?.lastAttemptedAt).toBe(101_000),
    );
    expect(fixture.logger.warn).toHaveBeenCalledWith(
      "thread-handoff handoff-1 start attempt 1 failed: dispatch refused",
    );
    fixture.store.close();
  });

  it("contains attempt-end persistence failures in the detached completion", async () => {
    const deferred = createDeferred<void>();
    const fixture = serviceFixture();
    const record = handoff();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    fixture.store.insertHandoff(record);
    dispatchTurn.mockReturnValueOnce(deferred.promise);
    vi.spyOn(fixture.store, "recordAttemptEnd").mockImplementation(() => {
      throw new Error("attempt end unavailable");
    });

    try {
      await fixture.service.startTurn(record);
      deferred.resolve(undefined);
      await vi.waitFor(() =>
        expect(fixture.logger.error).toHaveBeenCalledWith(
          expect.stringContaining(
            "handoff-1 could not finish its start attempt: attempt end unavailable",
          ),
        ),
      );
      await nextEventLoopTurn();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
      await fixture.service.stop();
      fixture.store.close();
    }
  });

  it("contains post-attempt logging failures even when fallback logging fails", async () => {
    const fixture = serviceFixture();
    const record = handoff();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    fixture.store.insertHandoff(record);
    dispatchTurn.mockRejectedValueOnce(new Error("dispatch refused"));
    fixture.logger.warn.mockImplementationOnce(() => {
      throw new Error("warning unavailable");
    });
    fixture.logger.error.mockImplementationOnce(() => {
      throw new Error("error logging unavailable");
    });

    try {
      await fixture.service.startTurn(record);
      await vi.waitFor(() => expect(fixture.logger.error).toHaveBeenCalledTimes(1));
      await nextEventLoopTurn();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
      await fixture.service.stop();
      fixture.store.close();
    }
  });

  it("respects attempt spacing and the cap, then logs the parked warning once", async () => {
    const fixture = serviceFixture();
    fixture.store.insertHandoff(
      handoff({
        handoffId: "spaced",
        routeKey: "spaced",
        attemptCount: 1,
        lastAttemptedAt: 90_000,
      }),
    );
    fixture.store.insertHandoff(
      handoff({
        handoffId: "capped",
        routeKey: "capped",
        targetSessionKey: "target-capped",
        attemptCount: MAX_ATTEMPTS,
        lastAttemptedAt: 0,
      }),
    );
    fixture.store.insertHandoff(
      handoff({
        handoffId: "last",
        routeKey: "last",
        targetSessionKey: "target-last",
        attemptCount: MAX_ATTEMPTS - 1,
        lastAttemptedAt: 0,
      }),
    );

    await fixture.service.start();
    expect(dispatchTurn).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(fixture.logger.warn).toHaveBeenCalledWith(expect.stringContaining("stays pending")),
    );
    const warning = fixture.logger.warn.mock.calls[0]?.[0];
    expect(warning).toContain("openclaw thread-handoff list");
    expect(warning).not.toContain("retire");
    expect(
      fixture.store.listPending({
        now: 100_000,
        spacingMs: ATTEMPT_SPACING_MS,
        maxAttempts: MAX_ATTEMPTS,
      }),
    ).toEqual([]);
    await fixture.service.stop();
    fixture.store.close();
  });
});

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function nextEventLoopTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function serviceFixture(options: { now?: () => number } = {}) {
  const store = createHandoffStore(temporaryStateDir());
  const runtime = {
    config: { current: () => ({}) },
  } as unknown as OpenClawPluginApi["runtime"];
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    store,
    runtime,
    logger,
    service: createHandoffService({
      runtime,
      configuration: { channelSurfaces: { slack: "slack", discord: "discord" } },
      getStore: () => store,
      logger: logger as unknown as PluginLogger,
      now: options.now ?? (() => 100_000),
    }),
  };
}
