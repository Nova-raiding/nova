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
      onNavigate: vi.fn(),
      model: {
        canModelMarkup: false,
        canModelMarkupUpdate: false,
        modelStatusLoading: false,
        dataSetError: () => undefined,
        dataSource: { fixtureDataPresent: false },
      } as unknown as OpsConsoleModel,
    }));

    expect(markup).toContain("当前会话没有商业计费读取权限");
    expect(markup).not.toContain("Token 成本倍率");
    expect(markup).not.toContain("Token 计费倍率");
    expect(markup).not.toContain("Revision");
  });

  it("renders the screenshot-aligned merged billing page and authorized controls", () => {
    const markup = renderToStaticMarkup(createElement(ModelsPage, {
      onNavigate: vi.fn(),
      model: {
        canModelMarkup: true,
        canModelMarkupUpdate: true,
        modelMarkup: undefined,
        modelMarkupLoading: false,
        modelMarkupError: "",
        modelMarkupReason: "",
        modelStatusLoading: false,
        dataSetError: () => undefined,
        dataSource: { fixtureDataPresent: false },
        setModelMarkup: vi.fn(),
        setModelMarkupReason: vi.fn(),
        saveModelMarkup: vi.fn(async () => undefined),
        loadModelMarkup: vi.fn(async () => undefined),
      } as unknown as OpsConsoleModel,
    }));

    expect(markup).toContain("模型计费设置");
    expect(markup).toContain("模型服务页已合并");
    expect(markup).toContain("查看平台总览");
    expect(markup).toContain("Token 成本倍率");
    expect(markup).toContain("Token 计费倍率");
    expect(markup).toContain("请重试或检查运营 API 与数据库迁移状态");
    expect(markup).toContain("重 试");
    expect(markup).toContain("MODEL BILLING");
    expect(markup).not.toContain("模型服务关键指标");
  });
});
