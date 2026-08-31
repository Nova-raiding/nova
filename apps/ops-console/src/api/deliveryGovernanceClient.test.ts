import { describe, expect, it } from "vitest";
import { parseDeliveryReadiness } from "./deliveryGovernanceClient.js";

const empty = {
  generatedAt: "2026-08-29T00:00:00.000Z",
  status: "unverified",
  dimensions: { mapping: "unverified", bundles: "unverified", authenticity: "unverified" },
  mappingPreflights: [], bundles: [], authenticity: [],
};

describe("delivery governance response", () => {
  it("preserves a real empty response as unverified", () => {
    expect(parseDeliveryReadiness(empty)).toEqual(empty);
    expect(parseDeliveryReadiness(null)).toBeNull();
  });

  it("parses mapping, bundle verification and authenticity evidence", () => {
    const value = {
      ...empty,
      status: "blocked",
      dimensions: { mapping: "passed", bundles: "blocked", authenticity: "unverified" },
      mappingPreflights: [{ id: "taobao:p-1", platform: "taobao", productId: "p-1", status: "passed", findings: [] }],
      bundles: [{ id: "v-1", taskId: "t-1", productId: "p-1", status: "blocked", findings: [{ code: "DELIVERY_BUNDLE_NOT_VERIFIED", message: "bundle 未通过", nextAction: "重新验证" }], verification: { valid: false, manifestHash: "manifest-hash", artifactSha256: "artifact-hash" } }],
      authenticity: [{ id: "visual-1", jobId: "job-1", productId: "p-1", status: "unverified", findings: [{ code: "VISUAL_AUTHENTICITY_MISSING", message: "缺少证据", nextAction: "执行 review" }] }],
    };
    expect(parseDeliveryReadiness(value)).toEqual(value);
  });

  it("rejects unknown statuses and incomplete evidence instead of inventing success", () => {
    expect(() => parseDeliveryReadiness({ ...empty, status: "success" })).toThrow("状态或时间");
    expect(() => parseDeliveryReadiness({ ...empty, dimensions: { ...empty.dimensions, mapping: "ok" } })).toThrow("dimensions");
    expect(() => parseDeliveryReadiness({ ...empty, bundles: [{ id: "v-1", taskId: "t-1", productId: "p-1", status: "passed", findings: [], verification: { valid: true } }] })).toThrow("bundles");
  });
});
