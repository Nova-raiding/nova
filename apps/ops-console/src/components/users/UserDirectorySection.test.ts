import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PlatformUser } from "../../types/ops";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel.js";
import { canWriteLoadedIdentity, sortUserDirectoryRows, userDirectoryPageRequest } from "./UserDirectorySection.js";

type DirectoryUser = PlatformUser & { createdAt: string };

function user(overrides: Partial<DirectoryUser>): DirectoryUser {
  return {
    id: "member-1",
    externalSubject: "subject-1",
    displayName: "Alice",
    role: "operator",
    status: "active",
    updatedAt: "2026-08-20T00:00:00.000Z",
    createdAt: "2026-08-10T00:00:00.000Z",
    workspaceId: "workspace-1",
    workspaceStatus: "active",
    ...overrides,
  };
}

describe("UserDirectorySection sorting", () => {
  const rows = [
    user({ id: "member-3", externalSubject: "subject-3", displayName: "Charlie", status: "suspended", createdAt: "2026-08-03T00:00:00.000Z" }),
    user({ id: "member-1", externalSubject: "subject-1", displayName: "alice", status: "active", createdAt: "2026-08-01T00:00:00.000Z" }),
    user({ id: "member-2", externalSubject: "subject-2", displayName: "Bob", status: "invited", createdAt: "2026-08-02T00:00:00.000Z" }),
  ];

  it("sorts names, member status and creation time without mutating the loaded page", () => {
    expect(sortUserDirectoryRows(rows, { field: "displayName", order: "ascend" }).map((row) => row.displayName)).toEqual(["alice", "Bob", "Charlie"]);
    expect(sortUserDirectoryRows(rows, { field: "status", order: "ascend" }).map((row) => row.status)).toEqual(["active", "invited", "suspended"]);
    expect(sortUserDirectoryRows(rows, { field: "createdAt", order: "descend" }).map((row) => (row as DirectoryUser).createdAt)).toEqual([
      "2026-08-03T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
    ]);
    expect(rows.map((row) => row.externalSubject)).toEqual(["subject-3", "subject-1", "subject-2"]);
  });

  it("retains active filters when pagination changes", () => {
    expect(userDirectoryPageRequest({ query: "Alice", status: "active", workspaceId: "workspace-1" }, 3, 50)).toEqual({
      query: "Alice",
      status: "active",
      workspaceId: "workspace-1",
      page: 3,
      pageSize: 50,
    });
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

  it("keeps the wide directory table inside a horizontal scroll surface on mobile", () => {
    const source = readFileSync(new URL("./UserDirectorySection.tsx", import.meta.url), "utf8");
    expect(source).toContain('scroll={{ x: "max-content" }}');
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
  });
});
