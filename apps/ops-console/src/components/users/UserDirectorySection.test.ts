import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlatformUser } from "../../types/ops";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel.js";
import { UserDirectorySection, canWriteLoadedIdentity, legacyCommercialSnapshotRows, userDirectoryPageRequest } from "./UserDirectorySection.js";

function user(overrides: Partial<PlatformUser>): PlatformUser {
  return {
    id: "member-1",
    externalSubject: "subject-1",
    displayName: "Alice",
    role: "operator",
    status: "active",
    updatedAt: "2026-08-20T00:00:00.000Z",
    workspaceId: "workspace-1",
    workspaceStatus: "active",
    ...overrides,
  };
}

describe("UserDirectorySection directory behavior", () => {
  it("preserves server order and does not advertise current-page status sorting as directory sorting", () => {
    const source = readFileSync(new URL("./UserDirectorySection.tsx", import.meta.url), "utf8");
    expect(source).toContain("dataSource={model.userDirectory.items}");
    expect(source).toContain('{ title: "激活状态", dataIndex: "status", width: 130, render:');
    expect(source).not.toContain("sortUserDirectoryRows");
    expect(source).not.toContain('dataIndex: "status", width: 130, sorter:');
  });

  it("retains active filters when pagination changes", () => {
    expect(userDirectoryPageRequest({ query: "Alice", status: "active", workspaceId: "workspace-1" }, 3, 50)).toEqual({
      query: "Alice",
      status: "active",
      workspaceId: "workspace-1",
      page: 3,
      pageSize: 50,
    });
    const source = readFileSync(new URL("./UserDirectorySection.tsx", import.meta.url), "utf8");
    expect(source).toContain("total: model.userDirectory.total");
    expect(source).not.toContain("total: attributeFilter ? sortedUsers.length");
  });

  it("supports invited users and clears every directory filter back to page one", () => {
    expect(userDirectoryPageRequest({ query: " Alice ", status: "invited", workspaceId: " ws-1 ", accountType: "all" }, 2, 10)).toEqual({
      query: "Alice", status: "invited", workspaceId: "ws-1", accountType: "all", page: 2, pageSize: 10,
    });
    expect(userDirectoryPageRequest({ query: "  ", status: "", accountType: "merchant" })).toEqual({
      accountType: "merchant", page: 1, pageSize: 10,
    });
    const source = readFileSync(new URL("./UserDirectorySection.tsx", import.meta.url), "utf8");
    expect(source).toContain('{ value: "invited", label: "待激活" }');
    expect(source).toContain('form.resetFields(); void model.loadUsers({ accountType: "merchant", page: 1 });');
  });

  it("clears bulk selections when filters or pagination change", () => {
    const source = readFileSync(new URL("./UserDirectorySection.tsx", import.meta.url), "utf8");
    expect(source).toContain('onFinish={(values) => { setSelectedUserKeys([]); void model.loadUsers');
    expect(source).toContain('if (extra.action !== "paginate") return;\n    setSelectedUserKeys([]);');
  });

  it("shows the actual number of access-ready merchant workspaces in the directory header", () => {
    const model = {
      authorization: { can: (capability: string) => capability === "identity.read" },
      userDirectory: { items: [], total: 9, identityCount: 9, workspaceCount: 1, offset: 0, limit: 20, truncated: false },
      userDirectoryLoading: false,
      userDirectoryError: "",
      userExporting: false,
      canPlatformOps: false,
      canUserGovernance: false,
      userDetail: undefined,
      userDetailLoading: false,
      opsSession: undefined,
    } as unknown as OpsConsoleModel;

    const markup = renderToStaticMarkup(createElement(UserDirectorySection, { model }));
    expect(markup).toContain("共 1 家商家工作区");
    expect(markup).toContain("已接入用户");
    expect(markup).not.toContain("共 9 家商家工作区");
  });

  it("keeps an unread directory distinct from a successfully read empty directory", () => {
    const baseModel = {
      authorization: { can: (capability: string) => capability === "identity.read" },
      userDirectory: { items: [], total: 0, identityCount: 0, workspaceCount: 0, offset: 0, limit: 10, truncated: false },
      userDirectoryLoading: false,
      userDirectoryError: "",
      userDirectoryCompatibilityWarning: "",
      userExporting: false,
      canPlatformOps: false,
      canUserGovernance: false,
      userDetail: undefined,
      userDetailLoading: false,
      opsSession: undefined,
    } as unknown as OpsConsoleModel;
    const rendered = (model: OpsConsoleModel) => renderToStaticMarkup(createElement(UserDirectorySection, { model }));
    const failed = rendered({ ...baseModel, userDirectoryError: "当前运营 API 版本不支持筛选运营平台账号" });
    expect(failed).toContain("用户目录未读取");
    expect(failed).not.toContain("共 0 家商家工作区");
    expect(failed).not.toContain("没有符合条件的用户成员关系");

    const loading = rendered({ ...baseModel, userDirectoryLoading: true });
    expect(loading).toContain("正在读取用户目录");
    expect(loading).not.toContain("共 0 家商家工作区");

    const empty = rendered(baseModel);
    expect(empty).toContain("共 0 家商家工作区");
    expect(empty).toContain("没有符合条件的用户成员关系");

    const emptyPlatform = rendered({ ...baseModel, userDirectoryFilters: { accountType: "platform" } });
    expect(emptyPlatform).toContain("共 0 个运营平台账号");
    expect(emptyPlatform).toContain("没有符合条件的运营平台账号");
    expect(emptyPlatform).not.toContain("没有符合条件的用户成员关系");
  });

  it("labels loaded rows using the requested account scope, not an unsubmitted form choice", () => {
    const baseModel = {
      authorization: { can: (capability: string) => capability === "identity.read" },
      userDirectory: { items: [user({ externalSubject: "merchant@example.test", accountType: "merchant" })], total: 1, identityCount: 1, workspaceCount: 1, offset: 0, limit: 10, truncated: false },
      userDirectoryFilters: { accountType: "merchant" },
      userDirectoryLoading: false,
      userDirectoryError: "",
      userDirectoryCompatibilityWarning: "",
      userExporting: false,
      canPlatformOps: false,
      canUserGovernance: false,
      userDetail: undefined,
      userDetailLoading: false,
      opsSession: undefined,
    } as unknown as OpsConsoleModel;
    const merchantMarkup = renderToStaticMarkup(createElement(UserDirectorySection, { model: baseModel }));
    expect(merchantMarkup).toContain("共 1 家商家工作区");
    expect(merchantMarkup).not.toContain("共 1 个运营平台账号");

    const platformMarkup = renderToStaticMarkup(createElement(UserDirectorySection, { model: {
      ...baseModel,
      userDirectory: { ...baseModel.userDirectory, items: [user({ externalSubject: "ops@example.test", accountType: "platform", workspaceId: "" })], workspaceCount: 0 },
      userDirectoryFilters: { accountType: "platform" },
    } }));
    expect(platformMarkup).toContain("共 1 个运营平台账号");
    expect(platformMarkup).not.toContain("共 0 家商家工作区");
  });

  it("keeps the desktop directory to five viewport-sized columns and opens detail for full identity fields", () => {
    const source = readFileSync(new URL("./UserDirectorySection.tsx", import.meta.url), "utf8");
    expect(source).toContain('{ title: "用户名", dataIndex: "externalSubject", width: 405');
    expect(source).toContain('{ title: "店铺名", dataIndex: "displayName", width: 213');
    expect(source).toContain('{ title: "激活状态", dataIndex: "status", width: 130');
    expect(source).toContain('{ title: "用户属性", dataIndex: "accountType", width: 177');
    expect(source).not.toContain('{ title: "工作区 ID"');
    expect(source).not.toContain('{ title: "姓名或显示名"');
    expect(source).toContain("loadUserDetail(row.externalSubject, row.identityId)");
  });

  it("requests 10 users by default while preserving explicit server page sizes", () => {
    expect(userDirectoryPageRequest({})).toEqual({ page: 1, pageSize: 10 });
    expect(userDirectoryPageRequest({}, 2, 50)).toEqual({ page: 2, pageSize: 50 });
  });

  it("excludes memberships without legacy facts from the snapshot table", () => {
    const withoutSnapshot = user({ id: "member-without-snapshot" });
    const withSnapshot = user({ id: "member-with-snapshot", commercial: {
      planCode: "legacy-starter", planName: "Starter", subscriptionStatus: "trial", usedTasks: 0,
      includedTasks: 30, remainingTasks: 30, walletBalanceCny: "0.00",
    } });
    expect(legacyCommercialSnapshotRows([withoutSnapshot])).toEqual([]);
    expect(legacyCommercialSnapshotRows([withoutSnapshot, withSnapshot])).toEqual([withSnapshot]);
  });

  it("keeps identity writes disabled until a persistent identity is fully loaded", () => {
    const state = (overrides: Partial<Pick<OpsConsoleModel, "canUserGovernance" | "userDetail" | "userDetailLoading">>) => ({
      canUserGovernance: true,
      userDetailLoading: false,
      userDetail: { identity: { id: "identity-1" } },
      ...overrides,
    }) as Pick<OpsConsoleModel, "canUserGovernance" | "userDetail" | "userDetailLoading">;

    expect(canWriteLoadedIdentity(state({}))).toBe(true);
    expect(canWriteLoadedIdentity(state({ userDetailLoading: true }))).toBe(false);
    expect(canWriteLoadedIdentity(state({ userDetail: undefined }))).toBe(false);
    expect(canWriteLoadedIdentity(state({ userDetail: { identity: {} } as OpsConsoleModel["userDetail"] }))).toBe(false);
    expect(canWriteLoadedIdentity(state({ canUserGovernance: false }))).toBe(false);
  });

  it("labels identity risk controls and presents risk levels in the operator's language", () => {
    const source = readFileSync(new URL("./UserDirectorySection.tsx", import.meta.url), "utf8");
    expect(source).toContain('<label htmlFor="identity-risk-level">风险级别</label>');
    expect(source).toContain('aria-label="风险级别"');
    expect(source).toContain('<label htmlFor="identity-risk-decision">处理方式</label>');
    expect(source).toContain('aria-label="处理方式"');
    expect(source).toContain('{ value: "critical", label: "严重" }');
    expect(source).not.toContain('{ value: "critical" }');
  });

  it("keeps the wide directory table inside a horizontal scroll surface on mobile", () => {
    const source = readFileSync(new URL("./UserDirectorySection.tsx", import.meta.url), "utf8");
    expect(source).toContain('scroll={{ x: "max-content" }}');
    expect(source).toContain('aria-label="用户目录数据表"');
  });

  it("makes table, drawer, and failed action forms recoverable for keyboard users", () => {
    const source = readFileSync(new URL("./UserDirectorySection.tsx", import.meta.url), "utf8");
    expect(source).toContain('aria-label="用户目录数据表"');
    expect(source).toContain('aria-label="用户目录详情抽屉"');
    expect(source).toContain("restoreUserDetailFocus");
    expect(source).toContain('role="alert" tabIndex={-1}');
    expect(source).toContain("已保留操作原因");
    expect(source).toContain('aria-describedby={actionError ? "user-access-error-title" : undefined}');
    expect(source).toContain('aria-describedby={actionError ? "bulk-suspend-error-title" : undefined}');
    expect(source).toContain('aria-describedby="user-access-error-description"');
    expect(source).toContain('aria-describedby="bulk-suspend-error-description"');
  });

  it("does not present a static, unbacked monthly spend chart as business data", () => {
    const source = readFileSync(new URL("./UserDirectorySection.tsx", import.meta.url), "utf8");
    expect(source).not.toContain("ops-usage-chart");
    expect(source).not.toContain("2026年用户总消耗金额");
  });

  it("retains account provisioning and authorized directory export actions in the secondary menu", () => {
    const source = readFileSync(new URL("./UserDirectorySection.tsx", import.meta.url), "utf8");
    expect(source).toContain('{ key: "provision", label: "开通商家账号", disabled: !model.canPlatformOps }');
    expect(source).toContain('{ key: "export", label: "导出商户成员", disabled: accountType !== "merchant" || !canExportUserDirectory(model.authorization) || model.userExporting }');
    expect(source).toContain('initialValues={{ status: "", accountType: "merchant" }}');
    expect(source).toContain('disabled: !canReadUserDirectory');
    expect(source).toContain('disabled={!canReadUserDirectory} maxLength={64}');
    expect(source).toContain('aria-label="按激活状态筛选用户目录" disabled={!canReadUserDirectory}');
    expect(source).toContain('aria-label="按账号属性筛选用户目录" disabled={!canReadUserDirectory}');
    expect(source).toContain('htmlType="submit" disabled={!canReadUserDirectory}');
    expect(source).toContain('aria-label="刷新用户目录" disabled={!canReadUserDirectory}');
    expect(source).toContain('{ value: "all", label: "全部" }');
    expect(source).toContain('accountType: nextAccountType, page: 1');
  });

  it("gives desktop directory controls stable, row-specific accessible names", () => {
    const source = readFileSync(new URL("./UserDirectorySection.tsx", import.meta.url), "utf8");
    expect(source).toContain('aria-label={`查看 ${row.displayName || row.externalSubject} 的用户详情`}');
    expect(source).toContain('aria-label={`${row.status === "suspended" ? "启用" : "停用"} ${row.displayName || row.externalSubject} 的访问`}');
    expect(source).toContain('{row.status === "suspended" ? "启用" : "停用"}');
    expect(source).toContain('aria-label="按关键词筛选用户目录"');
    // The column was renamed 成员状态 -> 激活状态 (7f6cf3f4); the filter has to
    // carry the same name as the column it filters.
    expect(source).toContain('aria-label="按激活状态筛选用户目录"');
    expect(source).not.toContain('aria-label="按用户属性筛选用户目录"');
    expect(source).not.toContain("userAttributeLabel");
    expect(source).not.toContain("monthlyEffectivePeriod");
    expect(source).not.toContain('title: "充值金额"');
    expect(source).not.toContain('title: "实际到账创意点"');
    expect(source).not.toContain('title: "充值时间"');
    expect(source).toContain("实收金额请核对财务流水");
  });

  it("keeps platform and merchant detail drawers discoverable as user details", () => {
    const source = readFileSync(new URL("./UserDirectorySection.tsx", import.meta.url), "utf8");
    expect(source).toContain('title={detailAccountType === "platform" ? "运营平台用户详情" : "商户用户详情"}');
    expect(source).toContain('aria-label="用户目录详情抽屉"');
  });

  it("does not manufacture member approval from a browser-selected name", () => {
    const source = readFileSync(new URL("./UserDirectorySection.tsx", import.meta.url), "utf8");
    expect(source).toContain("本操作由当前会话授权");
    expect(source).toContain("记录真实操作人");
    expect(source).not.toContain("suspendApprover");
    expect(source).not.toContain('aria-label="审批人"');
    expect(source).not.toContain("审批人：${");
  });

  it("keeps directory refresh errors distinguishable and recoverable without stealing focus during background refresh", () => {
    const source = readFileSync(new URL("./UserDirectorySection.tsx", import.meta.url), "utf8");
    expect(source).toContain('aria-busy={model.userDirectoryLoading}');
    expect(source).toContain('model.userDirectoryLoading ? "正在加载用户目录，已有结果会保留"');
    expect(source).toContain('if (initialDirectoryLoadFailed) directoryErrorRef.current?.focus({ preventScroll: true });');
    expect(source).toContain('role="alert" aria-live="assertive" aria-atomic="true" aria-label="用户目录错误摘要"');
    expect(source).toContain('model.userDirectory.items.length > 0 ? "已保留最近一次成功加载的用户目录');
    expect(source).toContain('aria-label="刷新用户目录"');
    expect(source).toContain('style={{ minHeight: 44 }}');
    expect(source).toContain('aria-describedby="user-directory-error-description"');
    expect(source).toContain('id="user-directory-error-description"');
  });

  it("defaults the directory to merchant accounts and stops reads without identity.read", () => {
    const modelSource = readFileSync(new URL("../../hooks/useOpsConsoleModel.ts", import.meta.url), "utf8");
    const componentSource = readFileSync(new URL("./UserDirectorySection.tsx", import.meta.url), "utf8");
    expect(modelSource).toContain('}>({ accountType: "merchant" });');
    expect(modelSource).toContain('if (!authorization.can("identity.read")) { recordOpsBootstrapTrace("users_load_skipped", { reason: "identity_read_denied" }); return false; }');
    expect(componentSource).toContain('Form.useWatch("accountType", form) ?? "merchant"');
    expect(componentSource).toContain('model.userDirectoryFilters?.accountType ?? "merchant"');
  });

  it("renders user directory search, filters, query, and refresh disabled without identity.read", () => {
    const model = {
      authorization: { can: () => false },
      userDirectory: { items: [], total: 0, identityCount: 0, workspaceCount: 0, offset: 0, limit: 10, truncated: false },
      userDirectoryLoading: false,
      userDirectoryError: "当前角色不能读取用户目录",
      userDirectoryCompatibilityWarning: "",
      userExporting: false,
      canPlatformOps: false,
      canUserGovernance: false,
      userDetail: undefined,
      userDetailLoading: false,
      opsSession: undefined,
    } as unknown as OpsConsoleModel;

    const markup = renderToStaticMarkup(createElement(UserDirectorySection, { model }));
    expect(markup.match(/<div[^>]*ant-select-disabled[^>]*>/gu)).toHaveLength(2);
    const submitButton = markup.match(/<button(?=[^>]*type="submit")[^>]*>/u)?.[0] ?? "";
    expect(submitButton).toMatch(/\bdisabled(?:="")?/u);
    const refreshButton = markup.match(/<button(?=[^>]*aria-label="刷新用户目录")[^>]*>/u)?.[0] ?? "";
    expect(refreshButton).toMatch(/\bdisabled(?:="")?/u);
    const queryInput = markup.match(/<input[^>]*aria-label="按关键词筛选用户目录"[^>]*>/u)?.[0] ?? "";
    expect(queryInput).toMatch(/\bdisabled(?:="")?/u);
  });
});
