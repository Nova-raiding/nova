import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";
import { createAuthorizationProjection } from "../authz/authorization.js";
import { StoragePage } from "./StoragePage.js";

const model = (capabilities: string[], overrides: Partial<OpsConsoleModel> = {}) => ({
  authorization: createAuthorizationProjection({
    actor_id: "viewer",
    workspace_id: "ws_a",
    roles: [],
    workspace_granted: true,
    capabilities,
  }, true),
  loading: false,
  dataSource: undefined,
  dataSetError: vi.fn(() => undefined),
  workspaceMetrics: undefined,
  storageReconciliationWorkspaces: [],
  load: vi.fn(async () => undefined),
  ...overrides,
}) as unknown as OpsConsoleModel;

describe("StoragePage platform reconciliation list", () => {
  it("does not present a missing capability as an empty reconciliation result", () => {
    // A workspace session can reach this page with `workspace.summary.read`
    // alone. The platform-wide list is never requested in that session, so its
    // empty state must not be the operator's only explanation.
    const markup = renderToStaticMarkup(<StoragePage model={model(["workspace.summary.read"])} />);

    expect(markup).toContain("当前会话没有平台存储对账读取权限");
    expect(markup).toContain("storage.reconciliation.read");
    expect(markup).toContain("不能解读为对账任务未运行");
  });

  it("keeps the reconciliation empty state for a session that may read the list", () => {
    const markup = renderToStaticMarkup(<StoragePage model={model(["storage.reconciliation.read"])} />);

    expect(markup).not.toContain("当前会话没有平台存储对账读取权限");
    expect(markup).toContain("暂无 workspace 级对账结果");
  });
});
