import { describe, expect, it } from "vitest";
import { parseGrantCapabilities } from "./AuthorizationGovernanceSection";

describe("AuthorizationGovernanceSection", () => {
  it("normalizes the comma-separated JIT capability input", () => {
    expect(parseGrantCapabilities(" support.ticket.read, ,catalog.image.retry\n")).toEqual([
      "support.ticket.read",
      "catalog.image.retry",
    ]);
  });

  it("does not manufacture a capability when the input is empty", () => {
    expect(parseGrantCapabilities(undefined)).toEqual([]);
  });
});
