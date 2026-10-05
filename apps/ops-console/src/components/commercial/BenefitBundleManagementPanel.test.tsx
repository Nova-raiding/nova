import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommercialBenefitBundle } from "../../api/commercialOperationsClient.js";
import type { OpsConsoleModel } from "../../hooks/useOpsConsoleModel.js";
import { BenefitBundleManagementPanel } from "./BenefitBundleManagementPanel.js";

const client = vi.hoisted(() => ({ benefitBundles: vi.fn(), mutateBenefitBundle: vi.fn(), benefitBundleReferences: vi.fn() }));
vi.mock("../../api/commercialOperationsClient.js", async importOriginal => ({ ...await importOriginal<typeof import("../../api/commercialOperationsClient.js")>(), commercialOperationsClient: client }));

const bundle = (lifecycle: string, state: string): CommercialBenefitBundle => ({
  id: "core-v1", code: "benefit-core", versionId: "core-v1", version: 1, name: "核心权益包", usage: "included",
  lifecycle, state, benefits: [], payload: {}, checksum: "sha256:test", revision: 3,
});
const model = (capabilities: string[]) => ({ authorization: { can: (capability: string) => capabilities.includes(capability) } }) as unknown as OpsConsoleModel;
const render = (item: CommercialBenefitBundle, capabilities: string[]) => {
  client.benefitBundles.mockResolvedValue({ items: [item], total: 1, nextCursor: null });
  return renderToStaticMarkup(<BenefitBundleManagementPanel model={model(capabilities)} definitions={[]} onChange={vi.fn()} />);
};

describe("benefit bundle operations authorization and lifecycle", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it("disables draft creation and every lifecycle write when the operator lacks capabilities", () => {
    const html = render(bundle("pending_business_approval", "active"), []);
    for (const label of ["新增权益组合草稿", "审批通过", "拒绝", "停用新绑定", "归档"]) {
      const start = html.lastIndexOf(`<button type="button"`);
      const button = html.slice(html.lastIndexOf("<button", html.indexOf(label)), html.indexOf(label));
      expect(button, label).toContain("disabled");
      expect(start).toBeGreaterThanOrEqual(0);
    }
  });

  it("offers only review actions for a pending bundle and keeps archive gated separately", () => {
    const html = render(bundle("pending_business_approval", "active"), ["commercial.catalog.approve"]);
    expect(html).toContain("审批通过");
    expect(html).toContain("拒绝");
    expect(html).not.toContain("提交审批");
    const approve = html.slice(html.lastIndexOf("<button", html.indexOf("审批通过")), html.indexOf("审批通过"));
    const archive = html.slice(html.lastIndexOf("<button", html.indexOf("归档")), html.indexOf("归档"));
    expect(approve).not.toContain("disabled");
    expect(archive).toContain("disabled");
  });

  it("does not offer new-binding retirement for a bundle that is not active", () => {
    const html = render(bundle("approved", "disabled"), ["commercial.catalog.publish"]);
    const retire = html.slice(html.lastIndexOf("<button", html.indexOf("停用新绑定")), html.indexOf("停用新绑定"));
    expect(retire).toContain("disabled");
    expect(html).toContain("已停用");
  });
});
