import { describe, expect, it } from "vitest";
import { deliveryCompletion, type CustomerDeliveryRecord } from "./CustomerDeliverySection";

const base: CustomerDeliveryRecord = {
  id: "c-1", companyName: "示例企业", paymentStatus: "paid", profile: true,
  integration: true, acceptance: true, training: true, videos: 1,
};

describe("customer delivery completion", () => {
  it("only marks a customer effective after every delivery item is complete", () => {
    expect(deliveryCompletion(base)).toEqual({ completed: 5, total: 5, ready: true });
    expect(deliveryCompletion({ ...base, videos: 0 })).toEqual({ completed: 4, total: 5, ready: false });
  });
});
