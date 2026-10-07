import { describe, expect, it } from "vitest";
import { commercialBenefitOptions, readableBenefitItems, readableBenefits } from "./benefitLabels.js";

describe("commercial benefit labels", () => {
  it("exposes stable operator options with default units", () => {
    expect(commercialBenefitOptions).toEqual(expect.arrayContaining([
      { code: "creative_points", label: "创意点", defaultUnit: "点" },
      { code: "cloud_storage", label: "共享存储", defaultUnit: "GB" },
    ]));
  });

  it("renders persisted benefits and legacy summaries without losing unknown values", () => {
    expect(readableBenefits({ benefits: [{ code: "creative_points", quantity: 5000, rawUnit: "creative_points", rawValue: "5000 点" }] } as any)).toContain("创意点：5000 点");
    expect(readableBenefitItems({ benefitsSummary: "creative_points:5000 点/月；future_code:按合同" } as any)).toEqual(["创意点：5000 点/月", "未翻译权益（future_code）：按合同"]);
    expect(readableBenefits({ benefitsSummary: "无已持久化权益项" } as any)).toContain("暂未配置套餐权益");
  });
});
