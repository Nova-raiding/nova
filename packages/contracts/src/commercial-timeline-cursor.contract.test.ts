import { describe, expect, it } from "vitest";
import { getMcpMethodContract, validateMcpRequest } from "./index.js";

describe("commercial timeline cursor contract", () => {
  it("declares a bounded cursor while keeping timeline filters optional", () => {
    expect(getMcpMethodContract("ops.commercial.timeline.list")?.params.properties.cursor).toMatchObject({ type: "string", maxLength: 4096 });
    expect(validateMcpRequest({
      jsonrpc: "2.0", id: "timeline-page-2", method: "ops.commercial.timeline.list",
      params: { target_workspace_id: "ws_1", limit: "100", cursor: "opaque-cursor" },
    })).toEqual({ valid: true, errors: [] });
  });
});
