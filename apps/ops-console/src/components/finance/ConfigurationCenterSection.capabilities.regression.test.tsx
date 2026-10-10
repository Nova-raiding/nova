import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfigurationCenterSection } from "./ConfigurationCenterSection.js";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel.js";

function renderConfiguration(grants: string[], error = "") {
  const model = {
    authorization: { can: (capability: string) => grants.includes(capability) },
    settings: {
      planCode: "basic",
      planName: "Basic",
      monthlyPriceCny: 10,
      annualPriceCny: 100,
      includedStores: 1,
      includedTasks: 10,
      revision: 1,
    },
    platformRows: [{
      platform: "taobao",
      enabled: true,
      displayName: "淘宝",
      storeAlias: "店铺",
      revision: 1,
      changeReason: "",
    }],
    setPlatformRows: () => undefined,
    platformOperations: [],
    orders: [],
    loading: false,
    saving: false,
    saveCommercial: async () => undefined,
    savePlatform: async () => undefined,
    dataSetError: () => error,
  } as unknown as OpsConsoleModel;

  return renderToStaticMarkup(<ConfigurationCenterSection model={model} />);
}

function inputById(html: string, id: string) {
  return html.match(new RegExp(`<input\\b[^>]*\\bid="${id}"[^>]*>`))?.[0] ?? "";
}

function inputByLabel(html: string, label: string) {
  return html.match(new RegExp(`<input\\b[^>]*\\baria-label="${label}"[^>]*>`))?.[0] ?? "";
}

function buttonByText(html: string, text: string) {
  return [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/gu)]
    .map(([button]) => button)
    .find((button) => button.replace(/<[^>]*>/gu, "").includes(text)) ?? "";
}

describe("ConfigurationCenterSection capability-specific controls", () => {
  it("shows commercial editing only with workspace.settings.update", () => {
    const commercialOnly = renderConfiguration(["workspace.settings.update"]);
    expect(inputById(commercialOnly, "planName")).not.toContain("disabled");
    expect(inputByLabel(commercialOnly, "taobao 展示名称")).toContain("disabled");

    const platformOnly = renderConfiguration(["platform.settings.update"]);
    expect(inputById(platformOnly, "planName")).toContain("disabled");
    expect(inputByLabel(platformOnly, "taobao 展示名称")).not.toContain("disabled");
  });

  it("does not let unrelated grants open either settings editor", () => {
    const html = renderConfiguration(["store.connection.update", "commercial.update"]);
    expect(inputById(html, "planName")).toContain("disabled");
    expect(inputByLabel(html, "taobao 展示名称")).toContain("disabled");
  });

  it("keeps the last settings snapshot visible but blocks writes after the settings read fails", () => {
    const grants = ["workspace.settings.update", "platform.settings.update"];
    const html = renderConfiguration(grants, "读取配置失败");
    expect(html).toContain("配置中心读取失败");
    expect(inputById(html, "planName")).toContain('value="Basic"');
    expect(inputById(html, "planName")).toContain("disabled");
    expect(inputByLabel(html, "taobao 展示名称")).toContain('value="淘宝"');
    expect(inputByLabel(html, "taobao 展示名称")).toContain("disabled");
    expect(buttonByText(html, "保存商业配置")).toContain("disabled");
    expect(buttonByText(html, "保存")).toContain("disabled");

    const recoveredHtml = renderConfiguration(grants);
    expect(inputById(recoveredHtml, "planName")).not.toContain("disabled");
    expect(inputByLabel(recoveredHtml, "taobao 展示名称")).not.toContain("disabled");
    expect(buttonByText(recoveredHtml, "保存商业配置")).not.toContain("disabled");
    expect(buttonByText(recoveredHtml, "保存")).not.toContain("disabled");
  });
});
