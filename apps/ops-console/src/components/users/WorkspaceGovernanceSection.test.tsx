import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import type { WorkspaceSummary } from "../../types/ops";
import { WorkspaceGovernanceSection, workspaceDirectoryPageRequest } from "./WorkspaceGovernanceSection.js";

const row: WorkspaceSummary = {
  workspaceId: "ws_qinghe",
  enterpriseName: "青禾商贸",
  status: "active",
  planName: "5000 版本",
  monthlyPriceCny: 5000,
  usedTasks: 12,
  includedTasks: 100,
  subscriptionStatus: "active",
  memberCount: 3,
};

const model = (overrides: Record<string, unknown> = {}) => ({
  workspaceRows: [],
  workspaceDirectory: { items: [], total: 0, offset: 0, limit: 20, hasMore: false },
  workspaceDirectoryLoading: false,
  workspaceDirectoryError: "",
  dataSetError: () => undefined,
  loadWorkspaceDirectory: async () => true,
  authorization: { can: (capability: string) => capability === "workspace.status.update" },
  opsSession: { workspace_id: "ws_other" },
  changeWorkspaceStatus: async () => true,
  ...overrides,
}) as unknown as OpsConsoleModel;

const render = (overrides: Record<string, unknown> = {}) =>
  renderToStaticMarkup(<WorkspaceGovernanceSection model={model(overrides)} />);

/** The card's own "N workspaces" indicator. */
const countLabel = (markup: string) => markup.match(/共 \d+ 个工作区|工作区数量未知[^<]*/u)?.[0];

describe("monthly workspace directory states", () => {
  it("keeps filters and requests the selected page from the server", () => {
    expect(workspaceDirectoryPageRequest("  Qinghe  ", "active", 3, 20)).toEqual({ query: "Qinghe", status: "active", merchantOnly: true, page: 3, pageSize: 20 });
    expect(workspaceDirectoryPageRequest("", undefined, 1, 20)).toEqual({ query: undefined, status: undefined, merchantOnly: true, page: 1, pageSize: 20 });
  });

  it("does not render a failed read as 0 workspaces", () => {
    const markup = render({ workspaceDirectoryError: "运营 API 请求超时。请检查 API 和数据库状态后重试。" });
    // The regression: a failed refresh kept the previous — or empty — row list
    // and the panel stated 「共 0 个工作区」 over data it never read.
    expect(countLabel(markup)).toBe("工作区数量未知：目录读取失败");
    expect(markup).not.toContain("共 0 个工作区");
    expect(markup).toContain('data-state="error"');
    expect(markup).toContain("运营 API 请求超时");
    expect(markup).toContain("重试加载运营数据");
    // The table's own empty text must not claim the directory is empty.
    expect(markup).not.toContain("暂无商家工作区记录");
    expect(markup).toMatch(/这不是空列表/u);
  });

  it("treats a console-wide dataset failure for this method as a failed read", () => {
    const markup = render({
      dataSetError: (method: string) =>
        method === "ops.workspaces.list"
          ? "部分数据集刷新失败（ops.workspaces.list）。页面保留上次成功数据，这些值可能已过期：运营服务暂时不可用"
          : undefined,
    });
    expect(countLabel(markup)).toBe("工作区数量未知：目录读取失败");
    expect(markup).toContain("1 个数据集刷新失败，页面已保留上次成功数据。");
    expect(markup).toContain("重试加载运营数据");
    expect(markup).not.toContain("共 0 个工作区");
    expect(markup).not.toContain("暂无商家工作区记录");
  });

  it("keeps a directory the server really answered empty as an empty state", () => {
    const markup = render();
    expect(countLabel(markup)).toBe("共 0 个工作区");
    expect(markup).toContain("暂无商家工作区记录");
    expect(markup).not.toContain('data-state="error"');
  });

  it("shows the server total rather than counting only the loaded page", () => {
    const markup = render({ workspaceRows: [], workspaceDirectory: { items: [row], offset: 40, limit: 20, hasMore: true, total: 73 } });
    expect(countLabel(markup)).toBe("共 73 个工作区");
    expect(markup).toContain("共 73 条记录");
    expect(markup).toContain("套餐标价（元/月）");
    expect(markup).toContain("实际收款以账务流水为准");
    expect(markup).toContain("ant-pagination-item-3 ant-pagination-item-active");
    expect(markup).toContain("青禾商贸");
    expect(markup).not.toContain('data-state="error"');
  });

  it("keeps the last successful rows visible under the failure notice", () => {
    const markup = render({ workspaceRows: [row], workspaceDirectory: { items: [row], total: 1, offset: 0, limit: 20, hasMore: false }, workspaceDirectoryError: "运营 API 请求超时。请检查 API 和数据库状态后重试。" });
    expect(markup).toContain("青禾商贸");
    expect(countLabel(markup)).toBe("工作区数量未知：目录读取失败");
  });

  it("keeps status governance available with permission and disables self lockout", () => {
    const markup = render({ workspaceDirectory: { items: [{ ...row, workspaceId: "ws_other" }], total: 1, offset: 0, limit: 20, hasMore: false } });
    expect(markup).toContain("停用租户");
    expect(markup).toContain("不能从当前路由工作区停用自身");
  });

  it("does not expose status changes without the server capability", () => {
    const markup = render({ workspaceDirectory: { items: [row], total: 1, offset: 0, limit: 20, hasMore: false }, authorization: { can: () => false } });
    expect(markup).toContain("当前角色只有租户目录读取权限");
    expect(markup).toContain("disabled=\"\"");
  });
});
