import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OpsPage } from "./OpsPage.js";

describe("OpsPage", () => {
  it("keeps page actions visible when the title is hidden", () => {
    const markup = renderToStaticMarkup(
      <OpsPage title="客户交付" hideTitle actions={<button>选择目标企业</button>}>
        <div>客户档案</div>
      </OpsPage>,
    );

    expect(markup).toContain("选择目标企业");
    expect(markup).toContain("客户档案");
    expect(markup).toContain("ops-page-header-actions-only");
    expect(markup).not.toContain("ops-page-title");
  });

  it("keeps the regular page header layout when its title is visible", () => {
    const markup = renderToStaticMarkup(
      <OpsPage title="客户交付" actions={<button type="button">刷新交付档案</button>}>
        <div>客户档案</div>
      </OpsPage>,
    );

    expect(markup).toContain('class="ops-page-header"');
    expect(markup).not.toContain("ops-page-header-actions-only");
  });
});
