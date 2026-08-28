import { describe, expect, it } from "vitest";
import {
  canViewModelMarkup,
  visiblePlanBillingTabKeys,
} from "./modelMarkupVisibility.js";

describe("model markup visibility", () => {
  it("allows only platform operations users", () => {
    expect(canViewModelMarkup(["platform_ops"])).toBe(true);
    expect(canViewModelMarkup(["workspace_owner", "finance"])).toBe(false);
  });

  it("removes the model billing tab without permission", () => {
    expect(visiblePlanBillingTabKeys(false)).not.toContain("model-markup");
    expect(visiblePlanBillingTabKeys(true)).toContain("model-markup");
  });
});
