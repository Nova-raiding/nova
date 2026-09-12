import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OpsWorkbenchSwitcher } from "./OpsWorkbenchSwitcher.js";

describe("OpsWorkbenchSwitcher", () => {
  it("exposes only the platform operations workbench", () => {
    const html = renderToStaticMarkup(
      <OpsWorkbenchSwitcher
        value="workspace"
        available={["workspace", "platform", "workspace"]}
      />,
    );

    expect(html).toContain("平台控制台");
    expect(html).not.toContain("商家工作区");
    expect(html).not.toContain("当前运营工作台，请主动选择");
  });

  it("does not expose a merchant-workbench transition control", () => {
    const html = renderToStaticMarkup(
      <OpsWorkbenchSwitcher
        value="platform"
        available={["platform", "workspace"]}
        switching
      />,
    );

    expect(html).toContain("平台控制台");
    expect(html).not.toContain("商家工作区");
    expect(html).not.toContain("正在切换运营工作台");
  });
});
