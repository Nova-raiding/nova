import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AuditTrailSection } from "./AuditTrailSection.js";

describe("AuditTrailSection", () => {
  it("keeps export disabled without platform operations permission", () => {
    const html = renderToStaticMarkup(
      <AuditTrailSection audits={[]} canExport={false} onExport={() => undefined} />,
    );
    expect(html).toContain("disabled");
    expect(html).toContain("需要平台运营权限");
    expect(html).toContain("不允许修改或删除历史记录");
  });
});
