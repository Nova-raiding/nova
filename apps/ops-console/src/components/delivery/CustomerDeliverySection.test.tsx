import { describe, expect, it } from "vitest";
import { ACCEPTANCE_ITEMS, CHECKLIST_DISPLAY_LABELS, INTEGRATION_ITEMS, buildChecklistItems, checklistDisplayLabel, deliveryCompletion, deliveryStatusLabel, isDeliveryStepBlocked, type CustomerDeliveryRecord } from "./CustomerDeliverySection";

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

  it("only marks a delivery record complete after every delivery item is complete", () => {
    expect(deliveryCompletion(base)).toEqual({ completed: 5, total: 5, ready: true });
    expect(deliveryCompletion({ ...base, videos: 0 })).toEqual({ completed: 4, total: 5, ready: false });
  });

  it("labels the aggregate as delivery completion, never account activation", () => {
    expect(deliveryStatusLabel(deliveryCompletion(base))).toBe("交付已完成");
    expect(deliveryStatusLabel(deliveryCompletion({ ...base, videos: 0 }))).toBe("4/5");
  });

  it("counts each checklist item independently (not by a partial percentage)", () => {
    const keys = ["profile", "integration", "acceptance", "training"] as const;
    for (const key of keys) {
      expect(deliveryCompletion({ ...base, [key]: false })).toEqual({ completed: 4, total: 5, ready: false });
    }
    expect(deliveryCompletion({ ...base, videos: -1 })).toEqual({ completed: 4, total: 5, ready: false });
  });

  it("requires a positive video count and all four checklist states before completion", () => {
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

  it("builds one durable item payload per checklist entry and preserves explicit empty evidence", () => {
    expect(buildChecklistItems(["插件账号", "店铺连接"], ["插件账号"], { "插件账号": "  登录截图 #42  ", "店铺连接": null })).toEqual([
      { itemKey: "插件账号", completed: true, evidence: "登录截图 #42" },
      { itemKey: "店铺连接", completed: false, evidence: "" },
    ]);
  });

  it("fails closed for malformed form values instead of marking items complete", () => {
    expect(buildChecklistItems(INTEGRATION_ITEMS, undefined, undefined).every((item) => !item.completed && item.evidence === "")).toBe(true);
  });

  it("keeps durable keys while using the delivery brief's display labels", () => {
    expect(checklistDisplayLabel("插件账号")).toBe("插件账户");
    expect(checklistDisplayLabel("知识库")).toBe("知识库功能");
    expect(checklistDisplayLabel("创意点数")).toBe("创作点");
    expect(checklistDisplayLabel("标注编辑")).toBe("批注修改");
    expect(checklistDisplayLabel("店铺/商品读取")).toBe("店铺与商品资料读取");
    expect(checklistDisplayLabel("店铺连接")).toBe("店铺连接");
    expect(CHECKLIST_DISPLAY_LABELS).toMatchObject({
      插件账号: "插件账户",
      知识库: "知识库功能",
      创意点数: "创作点",
      标注编辑: "批注修改",
    });
  });
});
