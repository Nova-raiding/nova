import { describe, expect, it, vi } from "vitest";
import {
  alertListParams,
  IdempotencyOperationKeys,
  marketingQueueParams,
  prepareAutomationScopeLoad,
  runIdempotentOperation,
} from "./useOpsConsoleModel.js";

describe("Ops Console model helpers", () => {
  it("builds unfiltered queue and alert requests without stale fields", () => {
    expect(marketingQueueParams({})).toEqual({ limit: "50" });
    expect(alertListParams({})).toEqual({ status: "open", limit: "100" });
  });

  it("clears old automation data and resolves a concrete store scope", () => {
    const setScope = vi.fn();
    const setPolicy = vi.fn();
    const setScan = vi.fn();

    const params = prepareAutomationScopeLoad(
      "jd:store-1",
      [{ platform: "jd", accountId: "store-1" } as never],
      { setScope, setPolicy, setScan },
    );

    expect(params).toEqual({ platform: "jd", account_id: "store-1" });
    expect(setScope).toHaveBeenCalledWith("jd:store-1");
    expect(setPolicy).toHaveBeenCalledWith(undefined);
    expect(setScan).toHaveBeenCalledWith(undefined);
  });

  it("uses global automation params for an empty or unknown scope", () => {
    const clear = { setScope: vi.fn(), setPolicy: vi.fn(), setScan: vi.fn() };

    expect(prepareAutomationScopeLoad("", [], clear)).toEqual({});
    expect(prepareAutomationScopeLoad("jd:missing", [], clear)).toEqual({});
  });

  it("reuses the idempotency key after timeout and rotates it after success", async () => {
    let sequence = 0;
    const keys = new IdempotencyOperationKeys(() => `key-${++sequence}`);
    const observed: string[] = [];
    const timeout = Object.assign(new Error("timeout"), { code: "API_REQUEST_TIMEOUT" });

    await expect(runIdempotentOperation(keys, "risk:identity-1", async (key) => {
      observed.push(key);
      throw timeout;
    })).rejects.toBe(timeout);
    await expect(runIdempotentOperation(keys, "risk:identity-1", async (key) => {
      observed.push(key);
      return "ok";
    })).resolves.toBe("ok");
    await runIdempotentOperation(keys, "risk:identity-1", async (key) => {
      observed.push(key);
      return "next";
    });

    expect(observed).toEqual(["key-1", "key-1", "key-2"]);
  });

  it("rotates the idempotency key after cancellation or explicit failure", async () => {
    let sequence = 0;
    const keys = new IdempotencyOperationKeys(() => `key-${++sequence}`);
    const observed: string[] = [];
    const cancelled = Object.assign(new Error("cancelled"), { name: "AbortError" });

    await expect(runIdempotentOperation(keys, "session:1", async (key) => {
      observed.push(key);
      throw cancelled;
    })).rejects.toBe(cancelled);
    await runIdempotentOperation(keys, "session:1", async (key) => {
      observed.push(key);
      return undefined;
    });

    expect(observed).toEqual(["key-1", "key-2"]);
  });
});
