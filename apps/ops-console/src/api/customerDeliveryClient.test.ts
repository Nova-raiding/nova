import { describe, expect, it, vi } from "vitest";
import { parseCustomerDeliveryList } from "./customerDeliveryClient.js";

describe("customer delivery client", () => {
  it("parses aggregate snake_case response", () => {
    expect(parseCustomerDeliveryList({ items: [{ id: "cd_1", company_name: "Acme", payment_status: "paid", customerProfileStatus: "complete", systemIntegrationStatus: "complete", functionalAcceptanceStatus: "incomplete", trainingCompleted: false, videos: [{ id: "v" }] }] })).toMatchObject([{ id: "cd_1", companyName: "Acme", paymentStatus: "paid", profile: true, integration: true, acceptance: false, training: false, videos: 1 }]);
  });
  it("rejects malformed rows instead of returning empty state", () => {
    expect(() => parseCustomerDeliveryList({ items: [{ id: "cd_1" }] })).toThrow("客户交付接口返回了无效响应");
  });
});
