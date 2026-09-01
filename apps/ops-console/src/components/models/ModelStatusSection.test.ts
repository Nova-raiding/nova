import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import { ModelStatusSection } from "./ModelStatusSection";

function render(modelStatusLoading: boolean) {
  return renderToStaticMarkup(
    createElement(ModelStatusSection, {
      model: { modelStatus: undefined, modelStatusLoading, dataSetError: () => undefined, load: async () => undefined } as OpsConsoleModel,
    }),
  );
}

describe("ModelStatusSection", () => {
  it("distinguishes unresolved loading from a failed closed unavailable state", () => {
    expect(render(true)).toContain("加载中");
    const unavailable = render(false);
    expect(unavailable).toContain("不可用");
    expect(unavailable).toContain("平台模型状态不可用");
    expect(unavailable).not.toContain(">加载中<");
  });

  it("gives loading state a live status and avoids presenting an empty readiness table", () => {
    const markup = render(true);
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain("正在加载平台模型状态");
    expect(markup).not.toContain('模型可用性');
  });

  it("exposes a focusable error summary and keyboard-sized retry action", () => {
    const markup = renderToStaticMarkup(
      createElement(ModelStatusSection, {
        model: {
          modelStatus: undefined,
          modelStatusLoading: false,
          dataSetError: () => "模型状态读取失败",
          load: async () => undefined,
        } as OpsConsoleModel,
      }),
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-live="assertive"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('aria-label="重试加载平台模型状态"');
    expect(markup).toContain("min-height:44px");
    expect(markup).toContain("平台模型状态读取失败");
  });
});
