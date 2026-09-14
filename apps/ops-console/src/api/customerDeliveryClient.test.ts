import { describe, expect, it, vi } from "vitest";
import { buildChecklistUpdateParams, parseCustomerDeliveryList, parseCustomerDeliveryVideos } from "./customerDeliveryClient.js";

describe("customer delivery client", () => {
  it("parses aggregate snake_case response", () => {
    expect(parseCustomerDeliveryList({ items: [{ id: "cd_1", company_name: "Acme", payment_status: "paid", customerProfileStatus: "complete", systemIntegrationStatus: "complete", functionalAcceptanceStatus: "incomplete", trainingCompleted: false, videos: [{ id: "v" }] }] })).toMatchObject([{ id: "cd_1", companyName: "Acme", paymentStatus: "paid", profile: true, integration: true, acceptance: false, training: false, videos: 1 }]);
  });
  it("rejects malformed rows instead of returning empty state", () => {
    expect(() => parseCustomerDeliveryList({ items: [{ id: "cd_1" }] })).toThrow("客户交付接口返回了无效响应");
  });
  it("sends exactly one checklist update mode", () => {
    const params = buildChecklistUpdateParams({
      targetWorkspaceId: "workspace-1",
      deliveryId: "delivery-1",
      checklistKey: "system_integration",
      items: [{ itemKey: "插件账号", completed: true, evidence: "asset_ref:1" }],
      expectedRevision: 3,
    });
    expect(params.items_json).toContain("插件账号");
    expect(params).not.toHaveProperty("completed");
  });
  it("fails closed when the video list response is missing", () => {
    expect(() => parseCustomerDeliveryVideos(null)).toThrow("客户交付视频接口返回了无效响应");
    expect(() => parseCustomerDeliveryVideos({})).toThrow("客户交付视频接口返回了无效响应");
  });
});
