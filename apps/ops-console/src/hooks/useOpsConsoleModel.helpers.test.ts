import { describe, expect, it, vi } from "vitest";
import {
  allowedBackgroundHydrationMethods,
  alertListParams,
  dataSetErrorFor,
  dataSetErrorEvidenceFor,
  IdempotencyOperationKeys,
  marketingQueueParams,
  prepareAutomationScopeLoad,
  runIdempotentOperation,
  UserRequestGate,
} from "./useOpsConsoleModel.js";
import { createAuthorizationProjection } from "../authz/authorization.js";

describe("Ops Console model helpers", () => {
  it("requests only ops.session for a managed raw-role session without a projection", () => {
    const authorization = createAuthorizationProjection({
      roles: ["platform_ops"],
      workspace_id: "workspace-1",
    } as never, true);

    expect(authorization.source).toBe("deny-all");
    expect(["ops.session", ...allowedBackgroundHydrationMethods(authorization)])
      .toEqual(["ops.session"]);
  });

  it("maps a canonical projection to only its permitted request methods", () => {
    const authorization = createAuthorizationProjection({
      roles: ["platform_ops"],
      capabilities: ["workspace.directory.read", "marketing.summary.read"],
      scope: { type: "platform" },
    } as never, true);

    expect([...allowedBackgroundHydrationMethods(authorization)]).toEqual([
      "ops.workspaces.list",
      "ops.stores.list",
      "ops.brand-units.summary",
      "ops.tasks.summary",
      "ops.marketing.summary",
      "ops.growth.funnel",
      "ops.alerts.list",
    ]);
  });

  it("isolates dataset failures to the operations domain that owns them", () => {
    const failures = {
      "ops.audit.list": "审计中心仓储不可用",
      "automation.scan": "自动化扫描不可用",
    };

    expect(dataSetErrorFor(failures, ["workspace.health"])).toBeUndefined();
    expect(dataSetErrorFor(failures, ["automation.policy.get", "automation.scan"]))
      .toContain("automation.scan");
    expect(dataSetErrorFor(failures, ["automation.scan"])).not.toContain("ops.audit.list");
  });

  it("propagates a fatal load failure to every operations domain", () => {
    expect(dataSetErrorFor({ "*": "连接配置失效" }, ["workspace.health"]))
      .toBe("连接配置失效");
  });

  it("returns server diagnostics only when an actual dataset error supplied them", () => {
    expect(dataSetErrorEvidenceFor({ "ops.session": { requestId: "req-1", traceId: "trace-1", code: "FORBIDDEN" } }, ["ops.session"]))
      .toEqual({ requestId: "req-1", traceId: "trace-1", code: "FORBIDDEN" });
    expect(dataSetErrorEvidenceFor({}, ["ops.session"])).toBeUndefined();
  });

  it("builds unfiltered queue and alert requests without stale fields", () => {
    expect(marketingQueueParams({})).toEqual({ limit: "50" });
    expect(alertListParams({})).toEqual({ status: "open", limit: "100" });
    expect(alertListParams({}, true)).toEqual({ status: "open", limit: "100", platform_scope: "platform" });
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

  it("really aborts stale user filters and all work on unmount", () => {
    const gate = new UserRequestGate();
    const firstList = gate.beginDirectory();
    const secondList = gate.beginDirectory();
    const detail = gate.beginDetail();
    const exportJob = gate.beginExport();

    expect(firstList.signal.aborted).toBe(true);
    expect(secondList.signal.aborted).toBe(false);
    expect(detail.signal.aborted).toBe(false);
    expect(exportJob?.signal.aborted).toBe(false);

    gate.cancelAll();
    expect(secondList.signal.aborted).toBe(true);
    expect(detail.signal.aborted).toBe(true);
    expect(exportJob?.signal.aborted).toBe(true);
  });

  it("cancels a workspace directory request when the workbench changes", () => {
    const gate = new UserRequestGate();
    const first = gate.beginWorkspaceDirectory();
    const second = gate.beginWorkspaceDirectory();

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);

    gate.cancelAll();
    expect(second.signal.aborted).toBe(true);
    expect(gate.finishWorkspaceDirectory(first)).toBe(false);
    expect(gate.finishWorkspaceDirectory(second)).toBe(false);
  });

  it("locks user export until the active job finishes", () => {
    const gate = new UserRequestGate();
    const first = gate.beginExport();
    expect(first).toBeDefined();
    expect(gate.beginExport()).toBeUndefined();
    expect(gate.finishExport(first!)).toBe(true);
    expect(gate.beginExport()).toBeDefined();
  });
});
