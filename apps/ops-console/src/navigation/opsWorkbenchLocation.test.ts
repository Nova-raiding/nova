import { describe, expect, it } from "vitest";
import { urlForWorkbench, workbenchIntentFromLocation } from "./opsWorkbenchLocation.js";

describe("ops workbench URL intent", () => {
  it("defaults outside the URL helper and only accepts frozen values", () => {
    expect(workbenchIntentFromLocation({ search: "" })).toBeUndefined();
    expect(workbenchIntentFromLocation({ search: "?workbench=admin" })).toBeUndefined();
    expect(workbenchIntentFromLocation({ search: "?workbench=platform" })).toBe("platform");
  });

  it("updates only workbench intent and preserves route/query/hash", () => {
    expect(urlForWorkbench(
      { pathname: "/ops/audit", search: "?tab=events&workbench=workspace", hash: "#row-1" },
      "platform",
    )).toBe("/ops/audit?tab=events&workbench=platform#row-1");
  });
});
