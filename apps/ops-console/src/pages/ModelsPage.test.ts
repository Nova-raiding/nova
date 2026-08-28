import { describe, expect, it } from "vitest";
import { visibleModelsPageSections } from "./modelsPageVisibility.js";

describe("models page sections", () => {
  it("hides markup configuration without platform_ops permission", () => {
    expect(visibleModelsPageSections(false)).toEqual(["model-status"]);
  });

  it("shows markup configuration to platform_ops", () => {
    expect(visibleModelsPageSections(true)).toEqual(["model-status", "model-markup"]);
  });
});
