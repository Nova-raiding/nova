import { describe, expect, it } from "vitest";
import { isCurrentSupportRequest } from "./useSupportDomain.js";

describe("support request tenant boundary", () => {
  it("rejects a response from the previous workspace even before effect cleanup runs", () => {
    expect(isCurrentSupportRequest(4, 4, "ws_previous", "ws_current")).toBe(false);
  });

  it("rejects an older response in the same workspace", () => {
    expect(isCurrentSupportRequest(3, 4, "ws_current", "ws_current")).toBe(false);
  });

  it("accepts only the latest response for the active workspace", () => {
    expect(isCurrentSupportRequest(4, 4, "ws_current", "ws_current")).toBe(true);
  });
});
