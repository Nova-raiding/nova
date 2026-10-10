import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ModelMarkupPanel } from "./ModelMarkupPanel.js";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel.js";

describe("ModelMarkupPanel input guidance", () => {
  it("shows the allowed multiplier range and precision beside the input", () => {
    const markup = renderToStaticMarkup(createElement(ModelMarkupPanel, {
      model: {
        modelMarkup: { multiplier: 2.5, revision: 4 },
        modelMarkupLoading: false,
        modelMarkupError: "",
        modelMarkupReason: "",
        canModelMarkup: true,
        canModelMarkupUpdate: true,
        setModelMarkup: vi.fn(),
        setModelMarkupReason: vi.fn(),
        saveModelMarkup: vi.fn(async () => undefined),
        loadModelMarkup: vi.fn(async () => undefined),
      } as unknown as OpsConsoleModel,
    }));

    expect(markup).toContain("范围 1–10，最多 3 位小数");
    expect(markup).toContain('aria-label="Token 计费倍率"');
    expect(markup).toContain('aria-describedby="model-markup-multiplier-guidance"');
    expect(markup).toContain('id="model-markup-multiplier-guidance"');
  });

  it("keeps saving disabled and explains an out-of-range multiplier", () => {
    const markup = renderToStaticMarkup(createElement(ModelMarkupPanel, {
      model: {
        modelMarkup: { multiplier: 0.5, revision: 4 },
        modelMarkupLoading: false,
        modelMarkupError: "",
        modelMarkupReason: "verified adjustment",
        canModelMarkup: true,
        canModelMarkupUpdate: true,
        setModelMarkup: vi.fn(),
        setModelMarkupReason: vi.fn(),
        saveModelMarkup: vi.fn(async () => undefined),
        loadModelMarkup: vi.fn(async () => undefined),
      } as unknown as OpsConsoleModel,
    }));

    expect(markup).toContain("计费倍率必须在 1–10 之间");
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('disabled=""><span>保存并生效</span></button>');
  });
});
