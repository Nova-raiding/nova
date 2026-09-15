import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_ITEMS,
  INTEGRATION_ITEMS,
  deliveryCompletion,
  hasDeliveryVideo,
  isCustomerProfileFilled,
  isDeliveryChecklistComplete,
  isDeliveryStepBlocked,
  type CustomerDeliveryRecord,
} from "./CustomerDeliverySection.js";

const record: CustomerDeliveryRecord = {
  id: "delivery-1",
  companyName: "示例公司",
  contractNo: "20260915001",
  paymentStatus: "paid",
  profile: false,
  integration: false,
  acceptance: false,
  training: false,
  videos: 0,
  paymentDate: "2026-09-15",
  contractFile: "asset:contract",
  owner: "项目负责人",
  afterSalesOwner: "售后负责人",
  requiredLaunchAt: "2026-09-30",
};

describe("customer delivery overview status", () => {
  it("shows a fully populated customer profile as filled", () => {
    expect(isCustomerProfileFilled(record)).toBe(true);
    expect(isCustomerProfileFilled({ ...record, owner: "" })).toBe(false);
  });

  it("only derives checklist completion from every selected item with evidence", () => {
    expect(isDeliveryChecklistComplete({
      ...record,
      integrationItems: INTEGRATION_ITEMS,
      integrationEvidenceAssetRefs: Object.fromEntries(INTEGRATION_ITEMS.map((item) => [item, [`asset:${item}`]])),
    }, "integration")).toBe(true);
    expect(isDeliveryChecklistComplete({ ...record, acceptanceItems: ACCEPTANCE_ITEMS }, "acceptance")).toBe(false);
  });

  it("recognizes persisted video counts and legacy video URL records", () => {
    expect(hasDeliveryVideo({ ...record, videos: 1 })).toBe(true);
    expect(hasDeliveryVideo({ ...record, videoUrls: ["asset:video"] })).toBe(true);
    expect(hasDeliveryVideo(record)).toBe(false);
  });

  it("does not block delivery work on the manually verified payment field", () => {
    expect(isDeliveryStepBlocked("unpaid", "integration")).toBe(false);
    expect(isDeliveryStepBlocked("unpaid", "acceptance")).toBe(false);
    expect(isDeliveryStepBlocked("unpaid", "training")).toBe(false);
    expect(deliveryCompletion({
      ...record,
      paymentStatus: "unpaid",
      profile: true,
      integration: true,
      acceptance: true,
      training: true,
      videos: 1,
    })).toEqual({ completed: 5, total: 5, ready: true });
  });
});
