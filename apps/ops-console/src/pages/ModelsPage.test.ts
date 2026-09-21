import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { visibleModelsPageSections } from "./modelsPageVisibility.js";
import { ModelsPage } from "./ModelsPage.js";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";

describe("models page sections", () => {
  it("hides markup configuration without platform_ops permission", () => {
    expect(visibleModelsPageSections(false)).toEqual([]);
  });

  it("shows markup configuration to platform_ops", () => {
    expect(visibleModelsPageSections(true)).toEqual(["model-markup"]);
  });

  it("does not render billing data or controls without commercial read permission", () => {
    const markup = renderToStaticMarkup(createElement(ModelsPage, {
      model: {
        canModelMarkup: false,
        canModelMarkupUpdate: false,
      } as unknown as OpsConsoleModel,
    }));

    expect(markup).toContain("当前会话没有商业计费读取权限");
    expect(markup).not.toContain("Token 成本倍率");
    expect(markup).not.toContain("Token 计费倍率");
    expect(markup).not.toContain("Revision");
  });

  it("renders the merged-model notice and the billing markup controls without a redundant hero", () => {
    // This case used to grep the page source for the retired 模型服务 anchors
    // and their headings, which the source satisfied from a comment alone - it
    // stayed green while the page rendered none of them. Assert on what is
    // rendered instead, so a comment can never satisfy it again.
    const markup = renderToStaticMarkup(createElement(ModelsPage, {
      model: {
        canModelMarkup: true,
        canModelMarkupUpdate: true,
        modelMarkup: undefined,
        modelMarkupLoading: false,
        modelMarkupError: "",
        modelMarkupReason: "",
        setModelMarkup: vi.fn(),
        setModelMarkupReason: vi.fn(),
        saveModelMarkup: vi.fn(async () => undefined),
        loadModelMarkup: vi.fn(async () => undefined),
      } as unknown as OpsConsoleModel,
    }));

    expect(markup).not.toContain("ops-models-hero");
    expect(markup).toContain("模型服务页已合并");
    expect(markup).toContain("Token 成本倍率");
    expect(markup).toContain("Token 计费倍率");
    expect(markup).toContain("模型计费设置");
    // None of the retired anchors exist in rendered output, only in the
    // explanatory comment.
    expect(markup).not.toContain("BILLING CONTROL");
    expect(markup).not.toContain("models-runtime-heading");
    expect(markup).not.toContain("模型服务关键指标");
  });
});
