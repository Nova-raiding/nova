import { describe, expect, it, vi } from "vitest";
import { canExportUserDirectory } from "./userDirectoryPermission.js";

describe("user directory export authorization contract", () => {
  it("uses billing.export and does not infer export access from identity.update", () => {
    const identityWriter = { can: vi.fn((capability: string) => capability === "identity.update") };
    const billingExporter = { can: vi.fn((capability: string) => capability === "billing.export") };

    expect(canExportUserDirectory(identityWriter as never)).toBe(false);
    expect(canExportUserDirectory(billingExporter as never)).toBe(true);
    expect(identityWriter.can).toHaveBeenCalledExactlyOnceWith("billing.export");
    expect(billingExporter.can).toHaveBeenCalledExactlyOnceWith("billing.export");
  });
});
