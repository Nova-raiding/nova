import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ACCEPTANCE_ITEMS, CHECKLIST_DISPLAY_LABELS, CUSTOMER_DELIVERY_TABLE_WIDTHS, CustomerDeliverySection, CustomerDeliveryTrainingEvidence, INTEGRATION_ITEMS, buildChecklistItems, checklistDisplayLabel, customerDeliveryTrainingAction, deliveryCompletion, deliveryStatusLabel, isDeliveryStepBlocked, type CustomerDeliveryRecord } from "./CustomerDeliverySection";

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

  it("does not use the manually verified payment state as a delivery gate", () => {
    expect(deliveryCompletion({ ...base, paymentStatus: "unpaid" })).toEqual({ completed: 5, total: 5, ready: true });
  });

  it("does not promote legacy checkboxes to completion without a valid server completion timestamp", () => {
    expect(deliveryCompletion({ ...base, goLiveAt: undefined })).toEqual({ completed: 5, total: 5, ready: false });
    expect(deliveryCompletion({ ...base, goLiveAt: "not-a-date" }).ready).toBe(false);
  });

  it("never blocks delivery steps based on the manually verified payment state", () => {
    for (const step of ["integration", "acceptance", "training"] as const) {
      expect(isDeliveryStepBlocked("unpaid", step)).toBe(false);
      expect(isDeliveryStepBlocked("paid", step)).toBe(false);
    }
    expect(isDeliveryStepBlocked("unpaid", "profile")).toBe(false);
    expect(isDeliveryStepBlocked("unpaid", "video")).toBe(false);
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

  it("keeps each item's attachment mapping separate and rejects malformed arrays", () => {
    expect(buildChecklistItems(["插件账号", "店铺连接"], ["插件账号"], { 插件账号: "说明" }, { 插件账号: [" asset:login ", "asset:login"], 店铺连接: ["asset:shop"] })).toEqual([
      { itemKey: "插件账号", completed: true, evidence: "说明", evidenceAssetRefs: ["asset:login"] },
      { itemKey: "店铺连接", completed: false, evidence: "", evidenceAssetRefs: ["asset:shop"] },
    ]);
    expect(() => buildChecklistItems(["插件账号"], ["插件账号"], {}, { 插件账号: ["asset:login", false] })).toThrow("有效素材编号数组");
  });

  it("keeps training as an overview confirmation and asks for evidence only when missing", () => {
    expect(customerDeliveryTrainingAction({ ...base, training: false, trainingEvidenceRefs: [] }, true)).toBe("evidence");
    expect(customerDeliveryTrainingAction({ ...base, training: false, trainingEvidenceRefs: ["asset:training"] }, true)).toBe("save");
    expect(customerDeliveryTrainingAction({ ...base, trainingEvidenceRefs: ["asset:training"] }, false)).toBe("save");
    expect(customerDeliveryTrainingAction({ ...base, paymentStatus: "unpaid", trainingEvidenceRefs: ["asset:training"] }, true)).toBe("blocked");
  });

  it("renders training evidence inline with explicit confirmation instead of a second drawer", () => {
    const html = renderToStaticMarkup(<CustomerDeliveryTrainingEvidence record={{ ...base, training: false }} onConfirm={async () => {}} onClose={() => {}} />);
    expect(html).toContain('aria-label="示例企业 培训凭证"');
    expect(html).toContain('aria-label="已上传培训凭证"');
    expect(html).toContain("确认培训完成");
    expect(html).not.toContain('role="dialog"');
  });

  it("budgets desktop columns and preserves the complete company identity while pinning delivery status", () => {
    expect(Object.keys(CUSTOMER_DELIVERY_TABLE_WIDTHS)).toHaveLength(9);
    expect(Object.values(CUSTOMER_DELIVERY_TABLE_WIDTHS).reduce((sum, width) => sum + width, 0)).toBeLessThanOrEqual(1100);
    const companyName = "需要完整保留名称的企业-very-long-customer-company-name-without-breaks";
    const html = renderToStaticMarkup(<CustomerDeliverySection records={[{ ...base, companyName }]} />);
    expect(html).toContain('table-layout:fixed');
    expect(html).toContain('ant-table-cell-fix-end');
    expect(html).toContain(`title="${companyName}"`);
    expect(html).toContain('text-overflow:ellipsis');
    expect(html).toContain("交付已完成");
  });

  it("keeps read-only records visible while disabling overview mutation controls", () => {
    const html = renderToStaticMarkup(<CustomerDeliverySection readOnly records={[base]} />);
    expect(html).toContain("示例企业");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*><span>新建客户<\/span><\/button>/u);
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*type="checkbox"/u);
    expect(html).toContain("交付视频");
    expect(html).not.toContain("上传交付视频");
    expect(html).not.toContain("保存当前环节");
  });

  it("keeps read-only training evidence visible without upload or confirmation controls", () => {
    const html = renderToStaticMarkup(<CustomerDeliveryTrainingEvidence
      readOnly
      record={{ ...base, trainingEvidenceRefs: ["asset:existing-training-proof"] }}
      onUpload={async () => { throw new Error("Read-only upload must not run"); }}
      onGetAsset={async () => { throw new Error("Read-only upload must not run"); }}
      onConfirm={async () => { throw new Error("Read-only confirmation must not run"); }}
      onClose={() => {}}
    />);
    expect(html).toContain("asset:existing-training-proof");
    expect(html).toContain('aria-label="收起"');
    expect(html).not.toContain('type="file"');
    expect(html).not.toContain("确认培训完成");
  });

  it("keeps inline training confirmation above growing evidence lists without hiding saved references", () => {
    const html = renderToStaticMarkup(<CustomerDeliveryTrainingEvidence record={{ ...base, trainingEvidenceRefs: ["asset:existing-training-proof"] }} onConfirm={async () => {}} onClose={() => {}} />);
    expect(html).toContain('grid-template-columns:minmax(0, 1fr) minmax(320px, 1fr)');
    expect(html.indexOf("确认培训完成")).toBeLessThan(html.indexOf('aria-label="已上传培训凭证"'));
    expect(html).toContain("asset:existing-training-proof");
    expect(html).toContain('aria-label="收起"');
    expect(html).not.toContain("max-width:680px");
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
