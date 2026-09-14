import { describe, expect, it } from "vitest";
import { ACCEPTANCE_ITEMS, INTEGRATION_ITEMS, deliveryCompletion, isDeliveryStepBlocked, type CustomerDeliveryRecord } from "./CustomerDeliverySection";

const base: CustomerDeliveryRecord = {
  id: "c-1", companyName: "示例企业", paymentStatus: "paid", profile: true,
  integration: true, acceptance: true, training: true, videos: 1,
};

describe("customer delivery completion", () => {
  it("exposes the complete checklist required by the delivery brief", () => {
    expect(INTEGRATION_ITEMS).toEqual([
      "插件账号", "店铺连接", "商品扫描", "知识库", "平台规则",
      "创意点数", "企业信息", "品牌资产", "商品资料", "客户偏好",
    ]);
    expect(ACCEPTANCE_ITEMS).toEqual([
      "文案生成", "图片生成", "标注编辑", "自动检查", "视频生成",
      "店铺/商品读取", "技术验收", "内容验收",
    ]);
  });

  it("only marks a customer effective after every delivery item is complete", () => {
    expect(deliveryCompletion(base)).toEqual({ completed: 5, total: 5, ready: true });
    expect(deliveryCompletion({ ...base, videos: 0 })).toEqual({ completed: 4, total: 5, ready: false });
  });

  it("counts each checklist item independently (not by a partial percentage)", () => {
    const keys = ["profile", "integration", "acceptance", "training"] as const;
    for (const key of keys) {
      expect(deliveryCompletion({ ...base, [key]: false })).toEqual({ completed: 4, total: 5, ready: false });
    }
    expect(deliveryCompletion({ ...base, videos: -1 })).toEqual({ completed: 4, total: 5, ready: false });
  });

  it("requires a positive video count and all four checklist states before activation", () => {
    expect(deliveryCompletion({ ...base, videos: 0 }).ready).toBe(false);
    expect(deliveryCompletion({ ...base, videos: Number.NaN }).ready).toBe(false);
    expect(deliveryCompletion({ ...base, profile: false, integration: false, acceptance: false, training: false, videos: 99 })).toEqual({ completed: 1, total: 5, ready: false });
  });

  it("fails closed when all checkboxes are set on an unpaid customer", () => {
    expect(deliveryCompletion({ ...base, paymentStatus: "unpaid" })).toEqual({ completed: 5, total: 5, ready: false });
  });

  it("blocks only controlled delivery steps until payment is verified", () => {
    for (const step of ["integration", "acceptance", "training"] as const) {
      expect(isDeliveryStepBlocked("unpaid", step)).toBe(true);
      expect(isDeliveryStepBlocked("paid", step)).toBe(false);
    }
    expect(isDeliveryStepBlocked("unpaid", "profile")).toBe(false);
    expect(isDeliveryStepBlocked("unpaid", "video")).toBe(false);
  });
});
