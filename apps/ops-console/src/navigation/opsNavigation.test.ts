import { describe, expect, it } from "vitest";
import { canViewOpsDomain, domainFromLocation, opsDomains, requiredWorkbenchForDomain, urlForDomain, visibleOpsDomains } from "./opsNavigation.js";
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

  it.each([
    ["/ops", "/ops/overview"],
    ["/ops/", "/ops/overview"],
    ["/console/ops/", "/console/ops/overview"],
  ])("canonicalizes the Ops root %s without nesting a second ops segment", (pathname, expected) => {
    expect(urlForDomain({ pathname, search: "" }, "overview")).toBe(expected);
  });

  it.each([
    ["/ops/workspaces", "/ops/overview"],
    ["/ops/workspaces/", "/ops/overview"],
    ["/console/ops/workspaces", "/console/ops/overview"],
  ])("canonicalizes the unknown Ops deep link %s without duplicating the Ops path", (pathname, expected) => {
    expect(domainFromLocation({ pathname, hash: "" })).toBe("overview");
    expect(urlForDomain({ pathname, search: "?return=desktop" }, "overview"))
      .toBe(`${expected}?return=desktop`);
  });

  it.each(opsDomains)("keeps the legacy #%s bookmark compatible", (domain) => {
    expect(domainFromLocation({ pathname: "/", hash: `#${domain}` })).toBe(domain);
  });

  it("prefers a valid path route over a stale legacy hash", () => {
    expect(domainFromLocation({ pathname: "/ops/users", hash: "#finance" })).toBe("users");
  });

  it("keeps overview routes as the operations landing page", () => {
    expect(domainFromLocation({ pathname: "/ops/governance", hash: "" })).toBe("overview");
    expect(domainFromLocation({ pathname: "/ops/overview", hash: "" })).toBe("overview");
  });

  it("falls back to overview for unknown paths and hashes", () => {
    expect(domainFromLocation({ pathname: "/ops/unknown", hash: "#unknown" })).toBe("overview");
    expect(domainFromLocation({ pathname: "/ops/feature-flags", hash: "" })).toBe("overview");
  });

  it("canonicalizes the legacy finance task link to the task queue", () => {
    expect(domainFromLocation({ pathname: "/ops/finance/merchant/tasks", hash: "" })).toBe("tasks");
    expect(urlForDomain({ pathname: "/ops/finance/merchant/tasks", search: "" }, "tasks")).toBe("/ops/tasks");
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
    const support = authorization(["platform.summary.read", "support.ticket.read", "incident.read", "audit.read"]);
    expect(visibleOpsDomains(support)).toEqual(["overview", "audit"]);
    expect(opsDomains).toContain("finance");
  });

  it("lets platform operations reach every domain and local owner mode stay compatible", () => {
    const all = authorization(["platform.summary.read", "identity.read", "workspace.member.read", "workspace.directory.read", "marketing.summary.read", "customer.content.read", "platform.settings.read", "rule.read", "model.status.read", "storage.reconciliation.read", "billing.platform.read", "audit.read"]);
    expect(visibleOpsDomains(all)).toEqual(opsDomains);
    expect(visibleOpsDomains(authorization([], false))).toEqual([]);
  });

  it("does not expose platform-only domains to a workspace owner", () => {
    const visible = visibleOpsDomains(authorization(["workspace.summary.read", "workspace.member.read", "support.ticket.read", "incident.read", "customer.content.read", "store.connection.read", "rule.read", "model.status.read", "billing.workspace.read", "audit.read"]));
    expect(visible).toEqual([
      "overview", "members", "tasks", "knowledge", "stores", "rules", "models", "storage", "audit",
    ]);
    expect(visible).not.toContain("users");
    expect(visible).not.toContain("feature-flags");
  });

  it("canonicalizes the retired finance route to the overview workbench", () => {
    expect(domainFromLocation({ pathname: "/ops/finance", hash: "" })).toBe("overview");
    expect(domainFromLocation({ pathname: "/", hash: "#finance" })).toBe("overview");
  });

  it("keeps remaining Ops Console routes in their intended workbench", () => {
    expect(requiredWorkbenchForDomain("audit")).toBe("platform");
    expect(requiredWorkbenchForDomain("tasks")).toBe("workspace");
    expect(requiredWorkbenchForDomain("knowledge")).toBe("workspace");
  });
});
