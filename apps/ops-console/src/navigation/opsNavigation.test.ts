import { describe, expect, it } from "vitest";
import { canViewOpsDomain, domainFromLocation, opsDomains, urlForDomain, visibleOpsDomains } from "./opsNavigation.js";
import { createAuthorizationProjection } from "../authz/authorization.js";

const authorization = (capabilities: string[], managed = true) => createAuthorizationProjection(
  managed ? { actor_id: "actor_1", workspace_id: "ws_1", roles: [], workspace_granted: true, capabilities } : undefined,
  managed,
);

describe("operations navigation", () => {
  it.each(opsDomains)("initializes %s from its top-level route", (domain) => {
    expect(domainFromLocation({ pathname: `/ops/${domain}`, hash: "" })).toBe(domain);
    expect(domainFromLocation({ pathname: `/console/ops/${domain}/`, hash: "" })).toBe(domain);
  });

  it.each(opsDomains)("builds the %s URL while preserving base path and query", (domain) => {
    expect(urlForDomain(
      { pathname: "/console/ops/overview", search: "?tenant=demo&tab=active" },
      domain,
    )).toBe(`/console/ops/${domain}?tenant=demo&tab=active`);
  });

  it.each(opsDomains)("keeps the legacy #%s bookmark compatible", (domain) => {
    expect(domainFromLocation({ pathname: "/", hash: `#${domain}` })).toBe(domain);
  });

  it("prefers a valid path route over a stale legacy hash", () => {
    expect(domainFromLocation({ pathname: "/ops/users", hash: "#finance" })).toBe("users");
  });

  it("keeps legacy governance links mapped to overview", () => {
    expect(domainFromLocation({ pathname: "/ops/governance", hash: "" })).toBe("overview");
  });

  it("falls back to overview for unknown paths and hashes", () => {
    expect(domainFromLocation({ pathname: "/ops/unknown", hash: "#unknown" })).toBe("overview");
  });

  it("replaces an existing Ops route instead of nesting it", () => {
    expect(urlForDomain(
      { pathname: "/console/ops/users/", search: "?tenant=demo" },
      "tasks",
    )).toBe("/console/ops/tasks?tenant=demo");
  });

  it("adds an Ops route below a non-Ops base path", () => {
    expect(urlForDomain(
      { pathname: "/console/", search: "?tenant=demo" },
      "stores",
    )).toBe("/console/ops/stores?tenant=demo");
  });

  it("keeps support role navigation bounded while preserving incident response", () => {
    const support = authorization(["platform.summary.read", "support.ticket.read", "incident.read", "feature_flag.read", "audit.read"]);
    expect(visibleOpsDomains(support)).toEqual(["overview", "support", "incidents", "feature-flags", "audit"]);
    expect(canViewOpsDomain("finance", support)).toBe(false);
  });

  it("lets platform operations reach every domain and local owner mode stay compatible", () => {
    const all = authorization(["platform.summary.read", "identity.read", "workspace.member.read", "support.ticket.read", "incident.read", "marketing.summary.read", "platform.settings.read", "rule.read", "model.status.read", "feature_flag.read", "storage.reconciliation.read", "billing.platform.read", "audit.read"]);
    expect(visibleOpsDomains(all)).toEqual(opsDomains);
    expect(visibleOpsDomains(authorization([], false))).toEqual([]);
  });

  it("does not expose platform-only domains to a workspace owner", () => {
    const visible = visibleOpsDomains(authorization(["workspace.summary.read", "workspace.member.read", "support.ticket.read", "incident.read", "customer.content.read", "store.connection.read", "rule.read", "model.status.read", "billing.workspace.read", "audit.read"]));
    expect(visible).toEqual([
      "overview", "members", "support", "incidents", "tasks", "stores", "rules", "models", "storage", "finance", "audit",
    ]);
    expect(visible).not.toContain("users");
    expect(visible).not.toContain("feature-flags");
  });

  it("aligns finance navigation with workspace refund and reconciliation roles", () => {
    expect(canViewOpsDomain("finance", authorization(["billing.workspace.read", "billing.refund.execute"]))).toBe(true);
    expect(canViewOpsDomain("finance", authorization(["billing.self.read"]))).toBe(true);
    expect(canViewOpsDomain("finance", authorization(["customer.content.read"]))).toBe(false);
  });
});
