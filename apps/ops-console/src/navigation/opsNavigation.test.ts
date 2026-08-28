import { describe, expect, it } from "vitest";
import { domainFromLocation, opsDomains, urlForDomain } from "./opsNavigation.js";

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
});
