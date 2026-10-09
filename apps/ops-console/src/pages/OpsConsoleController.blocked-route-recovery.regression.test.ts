import { describe, expect, it } from "vitest";
import { blockedDomainRecoveryDomain } from "./OpsConsoleController.js";
import { createAuthorizationProjection } from "../authz/authorization.js";

describe("blocked workspace route recovery", () => {
  const authorization = (capabilities: string[]) => createAuthorizationProjection({
    actor_id: "actor_1",
    workspace_id: "platform",
    roles: [],
    workspace_granted: true,
    workbench: "platform",
    capabilities,
  }, true);

  it("prefers overview when the active platform identity can reach it", () => {
    expect(blockedDomainRecoveryDomain(
      authorization(["workspace.member.read", "platform.summary.read", "support.ticket.read"]),
      "platform",
    )).toBe("overview");
  });

  it("falls back to the first visible reachable domain and hides recovery when none is visible", () => {
    expect(blockedDomainRecoveryDomain(
      authorization(["workspace.member.read", "support.ticket.read", "billing.self.read"]),
      "platform",
    )).toBe("finance");
    expect(blockedDomainRecoveryDomain(authorization(["workspace.member.read"]), "platform")).toBeUndefined();
  });
});
