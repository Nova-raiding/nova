import { describe, expect, it } from "vitest";
import { packageCodeLabel, packageDisplayName } from "./packageLabels";

describe("package labels", () => {
  it("keeps unknown sku in Chinese fallback while exposing original code", () => {
    expect(packageDisplayName("sku-unknown-123")).toBe("未命名套餐（sku-unknown-123）");
    expect(packageCodeLabel("sku-unknown-123")).toBe("未命名套餐（sku-unknown-123） · sku-unknown-123");
  });

  it("builds readable monthly subscription fallback", () => {
    expect(packageDisplayName("sku-monthly-8000")).toBe("月度订阅（8000 元）");
    expect(packageCodeLabel("sku-monthly-8000")).toBe("月度订阅（8000 元） · sku-monthly-8000");
  });

  it("labels the 10000 yuan third tier as 尊享版 consistently", () => {
    expect(packageDisplayName("custom")).toBe("尊享版");
    expect(packageDisplayName("monthly_custom")).toBe("尊享版");
    expect(packageDisplayName("sku-monthly-10000")).toBe("尊享版");
    expect(packageCodeLabel("sku-monthly-10000")).toBe("尊享版 · sku-monthly-10000");
  });

  it("uses server name when available and authoritative", () => {
    expect(packageDisplayName("sku-unknown-123", "运营定制版")).toBe("运营定制版");
  });
});
