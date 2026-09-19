import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { ACCEPTANCE_ITEMS, CHECKLIST_DISPLAY_LABELS, CustomerDeliverySection, INTEGRATION_ITEMS, buildChecklistItems, checklistDisplayLabel, deliveryCompletion, deliveryLaunchDateLabel, deliveryStatusLabel, filterCustomerDeliveryRecords, isDeliveryChecklistComplete, isDeliveryStepBlocked, type CustomerDeliveryRecord } from "./CustomerDeliverySection";

const base: CustomerDeliveryRecord = {
  id: "c-1", companyName: "示例企业", paymentStatus: "paid", profile: true,
  integration: true, acceptance: true, training: true, videos: 1,
  goLiveAt: "2026-09-14T10:00:00.000Z",
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
    expect(deliveryCompletion(base)).toEqual({ completed: 4, total: 4, ready: true });
    expect(deliveryCompletion({ ...base, videos: 0 })).toEqual({ completed: 4, total: 4, ready: true });
  });

  it("labels the aggregate as delivery completion, never account activation", () => {
    expect(deliveryStatusLabel(deliveryCompletion(base))).toBe("交付已完成");
    expect(deliveryStatusLabel(deliveryCompletion({ ...base, training: false }))).toBe("3/4");
  });

  it("counts each checklist item independently (not by a partial percentage)", () => {
    const keys = ["profile", "integration", "acceptance", "training"] as const;
    for (const key of keys) {
      expect(deliveryCompletion({ ...base, [key]: false })).toEqual({ completed: 3, total: 4, ready: false });
    }
    expect(deliveryCompletion({ ...base, videos: -1 })).toEqual({ completed: 4, total: 4, ready: true });
  });

  it("ignores legacy video data and requires all four delivery states", () => {
    expect(deliveryCompletion({ ...base, videos: 0 }).ready).toBe(true);
    expect(deliveryCompletion({ ...base, videos: Number.NaN }).ready).toBe(true);
    expect(deliveryCompletion({ ...base, profile: false, integration: false, acceptance: false, training: false, videos: 99 })).toEqual({ completed: 0, total: 4, ready: false });
  });

  it("does not use the manually verified payment state as a delivery gate", () => {
    expect(deliveryCompletion({ ...base, paymentStatus: "unpaid" })).toEqual({ completed: 4, total: 4, ready: true });
  });

  it("never blocks delivery steps based on the manually verified payment state", () => {
    for (const step of ["integration", "acceptance", "training"] as const) {
      expect(isDeliveryStepBlocked("unpaid", step)).toBe(false);
      expect(isDeliveryStepBlocked("paid", step)).toBe(false);
    }
    expect(isDeliveryStepBlocked("unpaid", "profile")).toBe(false);
  });

  it("builds one durable item payload per checklist entry and preserves explicit empty evidence", () => {
    expect(buildChecklistItems(["插件账号", "店铺连接"], ["插件账号"], { "插件账号": "  登录截图 #42  ", "店铺连接": null })).toEqual([
      { itemKey: "插件账号", completed: true, evidence: "登录截图 #42", evidenceAssetRefs: [] },
      { itemKey: "店铺连接", completed: false, evidence: "", evidenceAssetRefs: [] },
    ]);
  });

  it("fails closed for malformed form values instead of marking items complete", () => {
    expect(buildChecklistItems(INTEGRATION_ITEMS, undefined, undefined).every((item) => !item.completed && item.evidence === "")).toBe(true);
  });

  it("marks fully selected manually verified checklists complete without uploaded evidence", () => {
    expect(isDeliveryChecklistComplete({ ...base, integration: false, integrationItems: [...INTEGRATION_ITEMS] }, "integration")).toBe(true);
    expect(isDeliveryChecklistComplete({ ...base, acceptance: false, acceptanceItems: [...ACCEPTANCE_ITEMS] }, "acceptance")).toBe(true);
  });

  it("shows the requested launch date before the customer is actually live", () => {
    expect(deliveryLaunchDateLabel({ createdAt: "2026-09-16T00:00:00.000Z" })).toBe("2026-09-16");
    expect(deliveryLaunchDateLabel({ createdAt: undefined })).toBe("未填写");
    expect(deliveryLaunchDateLabel({})).toBe("未填写");
  });

  it("exposes training evidence without making read-only sessions writable", () => {
    const html = renderToStaticMarkup(<CustomerDeliverySection disabled records={[base]} />);
    expect(html).toContain("示例企业");
    expect(html).toContain('aria-label="示例企业客户培训状态"');
    expect(html).not.toContain("交付视频");
    expect(html).toContain("查看详情");
    const source = readFileSync(new URL("./CustomerDeliverySection.tsx", import.meta.url), "utf8");
    expect(source).toContain("客户培训凭证");
    expect(source).toContain("已上传培训凭证");
  });

  it("filters records by company name and configured owners", () => {
    const records = [
      { ...base, id: "c-1", companyName: "星河科技", owner: "姜伟", afterSalesOwner: "韩先晓" },
      { ...base, id: "c-2", companyName: "远山贸易", owner: "李风", afterSalesOwner: "姜伟" },
    ];
    expect(filterCustomerDeliveryRecords(records, { keyword: "星河" })).toEqual([records[0]]);
    expect(filterCustomerDeliveryRecords(records, { owner: "李风", afterSalesOwner: "姜伟" })).toEqual([records[1]]);
    expect(filterCustomerDeliveryRecords(records, { keyword: "贸易", owner: "姜伟" })).toEqual([]);
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
