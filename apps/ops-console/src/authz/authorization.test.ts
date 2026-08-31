import { describe, expect, it } from "vitest";
import { canViewDomain, createAuthorizationProjection, domainReadCapabilities } from "./authorization.js";
import type { OpsSession } from "../types/ops.js";
import { CANONICAL_ROLES } from "../../../../packages/contracts/src/authz.js";

const session = (roles: string[], overrides: Partial<OpsSession> = {}): OpsSession => ({
  actor_id: "actor_1",
  workspace_id: "ws_1",
  roles,
  workspace_granted: true,
  ...overrides,
});

describe("authorization projection", () => {
  it("uses server effective permissions instead of expanding roles", () => {
    const authorization = createAuthorizationProjection(session(["platform_ops"], {
      effective_permissions: [
        { id: "rule.read", effect: "allow" },
        { id: "billing.platform.read", effect: "deny" },
      ],
    }), true);
    expect(authorization.source).toBe("server");
    expect(canViewDomain(authorization, "rules")).toBe(true);
    expect(canViewDomain(authorization, "finance")).toBe(false);
    expect(canViewDomain(authorization, "users")).toBe(false);
  });

  it("accepts the canonical capability field returned by ops.session", () => {
    const authorization = createAuthorizationProjection(session(["workspace_owner"], {
      effective_permissions: [
        { capability: "marketing.queue.read", effect: "allow", scope: { type: "workspace", ids: ["ws_1"] } },
      ],
    }), false);
    expect(authorization.can("marketing.queue.read")).toBe(true);
    expect(authorization.can("marketing.queue.update")).toBe(false);
  });

  it("makes explicit deny override a flat capability", () => {
    const authorization = createAuthorizationProjection(session(["platform_ops"], {
      capabilities: ["billing.platform.read"],
      effective_permissions: [{ id: "billing.platform.read", effect: "deny" }],
    }), true);
    expect(authorization.can("billing.platform.read")).toBe(false);
  });

  it("keeps finance navigation aligned with canonical finance actions", () => {
    const authorization = createAuthorizationProjection(session(["finance"], {
      capabilities: ["billing.workspace.read", "billing.refund.execute"],
    }), true);
    expect(canViewDomain(authorization, "finance")).toBe(true);
    expect(authorization.can("billing.refund.execute")).toBe(true);
  });

  it("lets platform operations read rules without receiving rule write access", () => {
    const authorization = createAuthorizationProjection(session(["platform_ops"], {
      capabilities: ["rule.read"],
    }), true);
    expect(canViewDomain(authorization, "rules")).toBe(true);
    expect(authorization.can("rule.update")).toBe(false);
    expect(authorization.can("rule.publish.approve")).toBe(false);
  });

  it("does not describe a workspace role as platform scoped", () => {
    expect(createAuthorizationProjection(session(["workspace_owner"]), true).scope).toEqual({ kind: "workspace", id: "ws_1" });
    expect(createAuthorizationProjection(session(["platform_ops"]), true).scope).toEqual({ kind: "platform" });
  });

  it("fails closed while a managed session has not loaded", () => {
    const authorization = createAuthorizationProjection(undefined, true);
    expect(authorization.capabilities.size).toBe(0);
    expect(canViewDomain(authorization, "overview")).toBe(false);
  });

  it("uses the server permission projection for local Bearer sessions too", () => {
    const authorization = createAuthorizationProjection(session(["workspace_owner"], {
      capabilities: ["marketing.queue.read"],
    }), false);
    expect(authorization.source).toBe("server");
    expect(authorization.can("marketing.queue.read")).toBe(true);
    expect(authorization.can("marketing.queue.update")).toBe(false);
    expect(canViewDomain(createAuthorizationProjection(undefined, false), "tasks")).toBe(false);
  });

  it("fails closed when a managed session has roles but no server permission projection", () => {
    const authorization = createAuthorizationProjection(session(["platform_ops"]), true);
    expect(authorization.source).toBe("deny-all");
    expect(authorization.capabilities.size).toBe(0);
    expect(authorization.can("platform.summary.read")).toBe(false);
    expect(canViewDomain(authorization, "overview")).toBe(false);
  });

  it("maps a real canonical server projection across all 13 domains", () => {
    const capabilities = [
      "platform.summary.read", "identity.read", "workspace.member.read", "support.ticket.read",
      "incident.read", "marketing.summary.read", "platform.settings.read", "rule.read",
      "model.status.read", "feature_flag.read", "storage.reconciliation.read", "billing.platform.read", "audit.read",
    ];
    const authorization = createAuthorizationProjection(session(["platform_ops"], {
      canonical_roles: ["ops_admin"],
      capabilities,
      policy_version: "2026-08-31.v1",
      scopes: [{ type: "self", ids: ["actor_1"] }, { type: "platform", ids: ["*"] }],
    }), true);
    expect(authorization.source).toBe("server");
    expect(authorization.policyVersion).toBe("2026-08-31.v1");
    for (const domain of Object.keys(domainReadCapabilities) as Array<keyof typeof domainReadCapabilities>) {
      expect(canViewDomain(authorization, domain), domain).toBe(true);
    }
  });

  it("keeps every canonical role fail-closed without a server projection", () => {
    for (const role of CANONICAL_ROLES) {
      const authorization = createAuthorizationProjection(session([role]), true);
      expect(authorization.source, role).toBe("deny-all");
      expect(authorization.capabilities.size, role).toBe(0);
      expect(authorization.can("workspace.member.manage"), role).toBe(false);
    }
  });

  it("does not infer unrelated domains from a canonical summary capability", () => {
    const authorization = createAuthorizationProjection(session(["platform_ops"], {
      capabilities: ["platform.summary.read"],
    }), true);
    expect(canViewDomain(authorization, "overview")).toBe(true);
    expect(canViewDomain(authorization, "users")).toBe(false);
    expect(canViewDomain(authorization, "tasks")).toBe(false);
    expect(canViewDomain(authorization, "feature-flags")).toBe(false);
  });
});
