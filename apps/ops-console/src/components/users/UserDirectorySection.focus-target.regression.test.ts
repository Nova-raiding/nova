import { describe, expect, it } from "vitest";
import type { PlatformUser } from "../../types/ops";
import { userDirectoryRowKey } from "./UserDirectorySection.js";

describe("user directory detail focus target", () => {
  it("distinguishes the same identity listed in different tenant memberships", () => {
    const first = { accountType: "merchant", workspaceId: "ws_one", externalSubject: "same-subject" } as PlatformUser;
    const second = { accountType: "merchant", workspaceId: "ws_two", externalSubject: "same-subject" } as PlatformUser;

    expect(userDirectoryRowKey(first)).not.toBe(userDirectoryRowKey(second));
    expect(userDirectoryRowKey(first)).toBe("merchant:ws_one:same-subject");
  });
});
