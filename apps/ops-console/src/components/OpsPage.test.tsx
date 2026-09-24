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
    expect(markup).not.toContain("ops-page-title");
  });
});
