import { describe, expect, it } from "vitest";
import { workspaceDirectoryOptionLabel } from "./UserDirectorySection.js";

describe("UserDirectorySection workspace option labels", () => {
  it("keeps an explicit workspace identity when the enterprise name is missing or blank", () => {
    expect(workspaceDirectoryOptionLabel({ workspaceId: "ws_missing" })).toBe("未命名企业主体 · ws_missing");
    expect(workspaceDirectoryOptionLabel({ workspaceId: "ws_blank", enterpriseName: "  " })).toBe("未命名企业主体 · ws_blank");
    expect(workspaceDirectoryOptionLabel({ workspaceId: "ws_named", enterpriseName: " 北区商家 " })).toBe("北区商家 · ws_named");
  });
});
