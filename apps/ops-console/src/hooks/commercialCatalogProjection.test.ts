import { describe, expect, it } from "vitest";
import { projectPlatformCommercialCatalog } from "./useOpsConsoleModel.js";
import { catalogProductRows } from "../components/commercial/catalogManagementModel.js";

describe("platform commercial catalog projection", () => {
  it("preserves sale revision zero, lifecycle, benefits and frozen payload for new drafts", () => {
    const items = projectPlatformCommercialCatalog([{
      id: "sku-opening-v1", sku_code: "opening", name: "开通费", type: "onboarding", visibility: "public",
      version: "v1", price_fen: 500000, price_label: "¥5000.00", cycle_label: "1 次", benefits_summary: "500 点",
      approval_state: "draft", executable: false, sale_state: "unlisted", sale_revision: 0,
      current_sale_version_id: null, payload: { grantSchedule: { grantCount: 6, pointsPerGrant: 500 } },
      benefits: [{ code: "creative_points", quantity: 500, raw_value: "500", raw_unit: "点", policy_ref: "approved", metadata: {} }],
    }]);
    expect(items[0]).toMatchObject({ saleRevision: 0, currentSaleState: "unlisted", executable: false, payload: { grantSchedule: { grantCount: 6 } }, benefits: [{ code: "creative_points", quantity: 500 }] });
    expect(catalogProductRows(items)[0]).toMatchObject({ saleRevision: 0, saleState: "unlisted", latest: { approvalState: "draft" } });
  });
});
