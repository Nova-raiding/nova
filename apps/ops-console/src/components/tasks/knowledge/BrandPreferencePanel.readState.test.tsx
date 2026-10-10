import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { OpsConsoleModel } from "../../../hooks/useOpsConsoleModel";
import { BrandPreferencePanel } from "./BrandPreferencePanel";

function renderPanel(overrides: Record<string, unknown> = {}) {
  const model = {
    brandPreference: undefined,
    canKnowledge: true,
    loading: false,
    dataSetError: vi.fn(() => undefined),
    load: vi.fn(),
    updateBrandPreference: vi.fn(),
    ...overrides,
  } as unknown as OpsConsoleModel;
  return { html: renderToStaticMarkup(<BrandPreferencePanel model={model} />), model };
}

describe("BrandPreferencePanel read state", () => {
  it("does not allow saving default values after the existing preference read failed", () => {
    const { html } = renderPanel({
      dataSetError: vi.fn(() => "knowledge.brand.preference.get: 数据库连接失败"),
    });

    expect(html).toContain("品牌偏好读取失败");
    expect(html).toContain("重试读取");
    expect(html).toContain("disabled=\"\"");
  });

  it("keeps the form disabled while the initial read is still pending", () => {
    const { html } = renderPanel({ loading: true });

    expect(html).toContain("正在读取品牌偏好");
    expect(html).toContain("disabled=\"\"");
  });

  it("allows a new draft when a successful read found no saved preference", () => {
    const { html } = renderPanel();

    expect(html).not.toContain("品牌偏好读取失败");
    expect(html).not.toContain("正在读取品牌偏好");
    expect(html).toContain("保存品牌偏好");
    expect(html).not.toContain("disabled=\"\"");
  });
});
