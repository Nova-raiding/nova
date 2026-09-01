import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";
import { createAuthorizationProjection } from "../authz/authorization.js";
import { UsersPage, usersPageCapabilityState } from "./UsersPage.js";

const model = (capabilities: string[], overrides: Partial<OpsConsoleModel> = {}) => ({
  authorization: createAuthorizationProjection({
    actor_id: "operator",
    workspace_id: "ops",
    roles: ["not_used_for_page_access"],
    workspace_granted: true,
    capabilities,
  }, true),
  error: "",
  load: vi.fn(async () => undefined),
  canUserGovernance: false,
  userDirectory: { items: [], total: 0, identityCount: 0, workspaceCount: 0, offset: 0, limit: 20, truncated: false },
  userDirectoryLoading: false,
  userDirectoryError: "",
  userExporting: false,
  userDetail: undefined,
  userDetailLoading: false,
  opsSession: undefined,
  loadUsers: vi.fn(async () => undefined),
  cancelUserRequests: vi.fn(),
  exportUsers: vi.fn(async () => undefined),
  suspendUsers: vi.fn(async () => ({ failed: 0 })),
  loadUserDetail: vi.fn(async () => undefined),
  suspendUser: vi.fn(async () => true),
  activateUser: vi.fn(async () => true),
  changeIdentityAccess: vi.fn(async () => true),
  transitionIdentityRisk: vi.fn(async () => true),
  revokeIdentitySession: vi.fn(async () => true),
  setUserDetail: vi.fn(),
  ...overrides,
}) as unknown as OpsConsoleModel;

describe("UsersPage capability state", () => {
  it("uses server capabilities for page status, regardless of raw role labels", () => {
    expect(usersPageCapabilityState(model(["identity.read"]).authorization)).toMatchObject({
      canRead: true,
      canWrite: false,
      canReadDirectory: true,
    });
    expect(usersPageCapabilityState(model([], { authorization: createAuthorizationProjection({ actor_id: "operator", workspace_id: "ops", roles: ["platform_admin"], workspace_granted: true, capabilities: [] }, true) }).authorization)).toMatchObject({
      canRead: false,
      canWrite: false,
    });
  });

  it("announces read-only capability state and keeps the page recovery path keyboard reachable", () => {
    const markup = renderToStaticMarkup(<UsersPage model={model(["identity.read"], { error: "运营 API 暂时不可用" })} />);

    expect(markup).toContain('data-capability-source="server"');
    expect(markup).toContain("当前为只读用户治理视图");
    expect(markup).toContain("运营 API 暂时不可用");
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-label="重试加载运营数据"');
  });

  it("fails closed with an assertive explanation when no server read capability is projected", () => {
    const markup = renderToStaticMarkup(<UsersPage model={model([], { error: "" })} />);

    expect(markup).toContain("当前会话没有用户治理读取能力");
    expect(markup).toContain('aria-live="assertive"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("不加载用户治理数据");
    expect(markup).not.toContain("角色 platform_admin");
  });
});
