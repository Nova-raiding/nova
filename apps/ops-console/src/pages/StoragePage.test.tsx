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
    const dataSetError = vi.fn(() => "对账读取被拒绝");
    const markup = renderToStaticMarkup(<StoragePage model={model(["workspace.summary.read"], { dataSetError })} />);

    expect(markup).toContain("当前会话没有平台存储对账读取权限");
    expect(markup).toContain("storage.reconciliation.read");
    expect(markup).toContain("不能解读为对账任务未运行");
    expect(markup).toContain("刷新存储摘要");
    expect(markup).not.toContain("重试加载对账结果");
    expect(dataSetError).not.toHaveBeenCalled();
  });

  it("does not show a storage refresh action when neither storage capability is available", () => {
    const markup = renderToStaticMarkup(<StoragePage model={model([])} />);

    expect(markup).not.toContain("刷新存储");
    expect(markup).not.toContain("重试加载对账结果");
  });

  it("does not treat a workspace-scoped storage grant as platform reconciliation access", () => {
    const dataSetError = vi.fn(() => "跨工作区读取被拒绝");
    const markup = renderToStaticMarkup(<StoragePage model={model(["storage.reconciliation.read"], { dataSetError })} />);

    expect(markup).toContain("当前会话没有平台存储对账读取权限");
    expect(markup).toContain("storage.reconciliation.read");
    expect(markup).not.toContain("重试加载对账结果");
    expect(dataSetError).not.toHaveBeenCalled();
  });

  it("keeps the reconciliation empty state for a session that may read the list", () => {
    const markup = renderToStaticMarkup(<StoragePage model={model(["storage.reconciliation.read"], {
      authorization: createAuthorizationProjection({
        actor_id: "platform-viewer",
        workspace_id: "",
        workbench: "platform",
        scope: { type: "platform" },
        roles: [],
        workspace_granted: true,
        capabilities: ["storage.reconciliation.read"],
      }, true),
    })} />);

    expect(markup).not.toContain("当前会话没有平台存储对账读取权限");
    expect(markup).toContain("暂无可验证的对象清单对账结果");
  });

  it("shows one actionable error when the reconciliation read fails", () => {
    const markup = renderToStaticMarkup(<StoragePage model={model(["storage.reconciliation.read"], {
      authorization: createAuthorizationProjection({
        actor_id: "platform-viewer",
        workspace_id: "",
        workbench: "platform",
        scope: { type: "platform" },
        roles: [],
        workspace_granted: true,
        capabilities: ["storage.reconciliation.read"],
      }, true),
      dataSetError: vi.fn(() => "对账服务暂时不可用"),
    })} />);

    expect(markup.match(/对账结果加载失败/g)).toHaveLength(1);
    expect(markup.match(/重试加载对账结果/g)).toHaveLength(1);
    expect(markup).toContain("对账服务暂时不可用");
  });
});
