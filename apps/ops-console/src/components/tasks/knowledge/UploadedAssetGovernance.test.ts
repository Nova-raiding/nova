import { describe, expect, it } from "vitest";
import { assetStatusLabel } from "./UploadedAssetGovernance.js";

describe("assetStatusLabel", () => {
  it("maps internal asset states to operator-facing Chinese labels", () => {
    expect(assetStatusLabel("unknown")).toBe("状态待确认");
    expect(assetStatusLabel("clean")).toBe("已通过");
    expect(assetStatusLabel("unusable")).toBe("不可用");
    expect(assetStatusLabel("unrecognized_state")).toBe("状态待确认");
  });
});
