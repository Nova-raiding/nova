import { describe, expect, it } from "vitest";
import { canReadOpsUserDetail } from "./userDetailAccess.js";

describe("Ops user detail read authorization", () => {
  it("allows identity.read users to open details without identity.update", () => {
    const authorization = {
      can: (capability: string) => capability === "identity.read",
    };
    expect(canReadOpsUserDetail(authorization)).toBe(true);
    expect(authorization.can("identity.update")).toBe(false);
  });

  it("does not allow users without identity.read to load details", () => {
    expect(canReadOpsUserDetail({ can: () => false })).toBe(false);
  });
});
