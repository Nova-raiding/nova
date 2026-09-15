import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MembersPage } from "./MembersPage.js";
import { createAuthorizationProjection } from "../authz/authorization.js";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel.js";
import type { OpsSession } from "../types/ops.js";

// Member mutation behavior is covered by MembersSection's own tests.
vi.mock("../components/finance/MembersSection", () => ({ MembersSection: () => null }));

describe("MembersPage current account", () => {
  it.each(["运营账号@example.com", undefined, null, "  "])("uses the shared account label (%s)", (login) => {
    const session: OpsSession = { actor_id: "private-internal-id", account_login: login, workspace_id: "ws", roles: ["merchant_admin"], workspace_granted: true };
    const model = { opsSession: session, authorization: createAuthorizationProjection(session, true), loading: false, load: vi.fn() } as unknown as OpsConsoleModel;
    const markup = renderToStaticMarkup(<MembersPage model={model} />);
    expect(markup).toContain(login?.trim() || "账号名称未提供");
    expect(markup).not.toContain("private-internal-id");
  });
});
