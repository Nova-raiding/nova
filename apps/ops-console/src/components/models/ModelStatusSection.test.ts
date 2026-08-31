import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel";
import { ModelStatusSection } from "./ModelStatusSection";

function render(modelStatusLoading: boolean) {
  return renderToStaticMarkup(
    createElement(ModelStatusSection, {
      model: { modelStatus: undefined, modelStatusLoading } as OpsConsoleModel,
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
});
