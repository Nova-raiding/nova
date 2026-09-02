import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OpsWorkbenchSwitcher } from "./OpsWorkbenchSwitcher.js";

describe("OpsWorkbenchSwitcher", () => {
  it("exposes only the server-projected workbenches with explicit selection guidance", () => {
    const html = renderToStaticMarkup(
      <OpsWorkbenchSwitcher
        value="workspace"
        available={["workspace", "platform", "workspace"]}
      />,
    );

    expect(html).toContain('aria-label="当前运营工作台，请主动选择"');
    expect(html).toContain("平台控制台");
    expect(html).toContain("商家工作区");
    expect(html).toContain("主动选择后将重新验证对应工作台的服务端授权范围");
    expect(html.match(/title="平台控制台"/g)).toHaveLength(1);
    expect(html.match(/title="商家工作区"/g)).toHaveLength(1);
  });

  it("announces the disabled transition state while the replacement session loads", () => {
    const html = renderToStaticMarkup(
      <OpsWorkbenchSwitcher
        value="platform"
        available={["platform", "workspace"]}
        switching
      />,
    );

    expect(html).toContain("aria-busy=\"true\"");
    expect(html).toContain('class="ant-segmented ant-segmented-disabled');
    expect(html).toContain('type="radio" disabled=""');
    expect(html).toContain('role="status"');
    expect(html).toContain("正在切换运营工作台，请稍候");
  });
});
