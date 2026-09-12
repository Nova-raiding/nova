import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { visibleModelsPageSections } from "./modelsPageVisibility.js";

describe("models page sections", () => {
  it("hides markup configuration without platform_ops permission", () => {
    expect(visibleModelsPageSections(false)).toEqual(["model-status"]);
  });

  it("shows markup configuration to platform_ops", () => {
    expect(visibleModelsPageSections(true)).toEqual(["model-status", "model-markup"]);
  });

  it("keeps the model page organized around runtime, capability, usage and billing sections without a redundant hero", () => {
    const source = readFileSync(new URL("./ModelsPage.tsx", import.meta.url), "utf8");
    expect(source).not.toContain('className="ops-models-hero"');
    expect(source).toContain('aria-label="模型服务关键指标"');
    expect(source).toContain('id="models-runtime-heading"');
    expect(source).toContain('id="models-capability-heading"');
    expect(source).toContain("平台模型用量");
    expect(source).toContain("BILLING CONTROL");
  });
});
