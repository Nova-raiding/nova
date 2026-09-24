import { describe, expect, it } from "vitest";
import { canViewOpsDomain, domainFromLocation, opsDomains, requiredWorkbenchForDomain, urlForDomain, urlForDomainWithQuery, visibleOpsDomains } from "./opsNavigation.js";
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

  it("carries the selected workspace between routes and preserves unrelated query and hash", () => {
    expect(urlForDomainWithQuery(
      { pathname: "/console/ops/overview", search: "?tab=active&workspace=old", hash: "#ledger" },
      "finance",
      { workspace: " ws_selected " },
    )).toBe("/console/ops/finance?tab=active&workspace=ws_selected#ledger");
  });

  it.each([...opsDomains, "governance"] as const)("recognizes and replaces the %s route", (currentDomain) => {
    const expectedDomain = currentDomain === "governance" ? "overview" : currentDomain;
    expect(domainFromLocation({ pathname: `/console/ops/${currentDomain}/`, hash: "" }))
      .toBe(expectedDomain);
    expect(urlForDomain(
      { pathname: `/console/ops/${currentDomain}/`, search: "?tenant=demo" },
      "tasks",
    )).toBe("/console/ops/tasks?tenant=demo");
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
    expect(domainFromLocation({ pathname: "/console/ops/finance/merchant/tasks/", hash: "" })).toBe("tasks");
    expect(urlForDomain({ pathname: "/console/ops/finance/merchant/tasks/", search: "?tenant=demo" }, "tasks"))
      .toBe("/console/ops/tasks?tenant=demo");
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
  });

  it("lets platform operations reach every domain and local owner mode stay compatible", () => {
    const all = authorization(["platform.summary.read", "identity.read", "workspace.member.read", "workspace.directory.read", "marketing.summary.read", "customer.content.read", "platform.settings.read", "rule.read", "model.status.read", "storage.reconciliation.read", "billing.platform.read", "audit.read"]);
    expect(visibleOpsDomains(all)).toEqual(opsDomains);
    expect(visibleOpsDomains(authorization([], false))).toEqual([]);
  });

  it("does not expose platform-only domains to a workspace owner", () => {
    const visible = visibleOpsDomains(authorization(["workspace.summary.read", "workspace.member.read", "support.ticket.read", "incident.read", "customer.content.read", "store.connection.read", "rule.read", "model.status.read", "billing.workspace.read", "audit.read"]));
    expect(visible).toEqual([
      "overview", "members", "tasks", "knowledge", "stores", "rules", "models", "storage", "finance", "audit",
    ]);
    expect(visible).not.toContain("users");
    expect(visible).not.toContain("feature-flags");
  });

  // 365c5d84 withdrew `/ops/finance` and this assertion was inverted to pin the
  // canonicalization to overview. The owner reversed that on 2026-09-20
  // (docs/qa/four-product-decisions-2026-09-20.md, option A restore), so the
  // route resolves to its own domain again. The `it.each(opsDomains)` cases
  // above already cover the plain path and hash forms now that finance is a
  // domain; what is finance-specific is the legacy merchant-tasks redirect.
  it("routes finance to its own domain instead of the overview fallback", () => {
    expect(domainFromLocation({ pathname: "/ops/finance", hash: "" })).toBe("finance");
    expect(domainFromLocation({ pathname: "/", hash: "#finance" })).toBe("finance");
    expect(domainFromLocation({ pathname: "/ops/finance/merchant/tasks", hash: "" })).toBe("tasks");
  });

  it("keeps finance dual-scope while all other Ops Console routes stay platform-scoped", () => {
    // `undefined` is the dual-scope signal, not a missing entry: it is what lets
    // 账务与退款 serve both the platform ledger and the enterprise-side
    // 账务与商业配置 from one domain. Assigning a workbench here would silently
    // drop one of those two faces.
    expect(requiredWorkbenchForDomain("finance")).toBeUndefined();
    expect(requiredWorkbenchForDomain("audit")).toBe("platform");
    expect(requiredWorkbenchForDomain("tasks")).toBe("workspace");
    expect(requiredWorkbenchForDomain("knowledge")).toBe("workspace");
  });

  it("opens finance for a platform ledger, a workspace refund role or a self-scoped reader", () => {
    expect(canViewOpsDomain("finance", authorization(["billing.platform.read"]))).toBe(true);
    expect(canViewOpsDomain("finance", authorization(["billing.workspace.read", "billing.refund.execute"]))).toBe(true);
    expect(canViewOpsDomain("finance", authorization(["billing.self.read"]))).toBe(true);
    expect(canViewOpsDomain("finance", authorization(["customer.content.read"]))).toBe(false);
  });
});
