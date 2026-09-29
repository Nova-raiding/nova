import { describe, expect, it, vi } from "vitest";
import {
  isLegacyAccountTypeContractError,
  loadUserDirectory,
  UnsupportedLegacyUserAccountFilterError,
  userDirectoryParams,
  userDirectoryResultKey,
} from "./userDirectoryCompatibility.js";

describe("ops user directory API compatibility", () => {
  it("builds the current API request including account scope and real pagination filters", () => {
    expect(userDirectoryParams({ accountType: "all", query: "  runner ", status: "active", workspaceId: " ws_1 ", page: 3, pageSize: 25 })).toEqual({
      limit: "25", offset: "50", query: "runner", status: "active", account_type: "all", workspace_id: "ws_1",
    });
  });

  it("keeps refresh results only for the same server-visible filters", () => {
    expect(userDirectoryResultKey({ accountType: "all" }))
      .toBe(userDirectoryResultKey({ accountType: "all", page: 1, pageSize: 10 }));
    expect(userDirectoryResultKey({ accountType: "merchant" }))
      .not.toBe(userDirectoryResultKey({ accountType: "platform" }));
    expect(userDirectoryResultKey({ accountType: "merchant", query: "Alice" }))
      .not.toBe(userDirectoryResultKey({ accountType: "merchant", query: "Bob" }));
    expect(userDirectoryResultKey({ accountType: "merchant", page: 1 }))
      .not.toBe(userDirectoryResultKey({ accountType: "merchant", page: 2 }));
  });

  it("retries an all-account request against the legacy mixed directory without a false warning", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("ops.users.list 不接受参数 params.account_type"), { code: "INVALID_REQUEST" }))
      .mockResolvedValueOnce({ items: [{ externalSubject: "db-member@example.test" }], total: 1 });

    const result = await loadUserDirectory(request, { accountType: "all", page: 2, pageSize: 10 });

    expect(request).toHaveBeenNthCalledWith(1, { limit: "10", offset: "10", account_type: "all" });
    expect(request).toHaveBeenNthCalledWith(2, { limit: "10", offset: "10" });
    expect(result.data).toEqual({ items: [{ externalSubject: "db-member@example.test" }], total: 1 });
    expect(result.compatibilityWarning).toBe("");
  });

  it("fails closed for merchant and platform filters when the legacy API cannot apply account_type", async () => {
    for (const accountType of ["merchant", "platform"] as const) {
      const request = vi.fn().mockRejectedValue(Object.assign(
        new Error("ops.users.list 不接受参数 params.account_type"),
        { code: "INVALID_REQUEST" },
      ));

      await expect(loadUserDirectory(request, { accountType }))
        .rejects.toBeInstanceOf(UnsupportedLegacyUserAccountFilterError);
      expect(request).toHaveBeenCalledTimes(1);
    }
  });

  it("only treats an explicit unknown-account_type validation as a legacy contract", () => {
    expect(isLegacyAccountTypeContractError(Object.assign(new Error("account_type 必须是 all、merchant 或 platform"), { code: "INVALID_REQUEST" }))).toBe(false);
    expect(isLegacyAccountTypeContractError(Object.assign(new Error("ops.users.list 不接受参数 params.account_type"), { code: "INVALID_REQUEST" }))).toBe(true);
  });
});
