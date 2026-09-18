import { afterEach, describe, expect, it, vi } from "vitest";
import { buildChecklistUpdateParams, customerDeliveryClient, parseCustomerDeliveryChecklistItems, parseCustomerDeliveryEvidenceRefs, parseCustomerDeliveryList, parseCustomerDeliveryVideos } from "./customerDeliveryClient.js";
import { rpc } from "./opsClient.js";

vi.mock("./opsClient.js", () => ({ rpc: vi.fn() }));
afterEach(() => vi.clearAllMocks());
const delivery = { id: "cd_1", companyName: "Acme", paymentStatus: "paid", profile: true, integration: true, acceptance: true, training: false, videos: 0 };

describe("customer delivery client", () => {
  it("parses aggregate snake_case response", () => {
    expect(parseCustomerDeliveryList({ items: [{ id: "cd_1", company_name: "Acme", payment_status: "paid", customerProfileStatus: "complete", systemIntegrationStatus: "complete", functionalAcceptanceStatus: "incomplete", trainingCompleted: false, videos: [{ id: "v" }], created_at: "2026-09-16T00:01:02.000Z" }] })).toMatchObject([{ id: "cd_1", companyName: "Acme", paymentStatus: "paid", profile: true, integration: true, acceptance: false, training: false, videos: 1, createdAt: "2026-09-16T00:01:02.000Z" }]);
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
  it("gives atomic checklist evidence verification a bounded long timeout", async () => {
    vi.mocked(rpc).mockResolvedValue({ items: [] });
    const signal = new AbortController().signal;
    await customerDeliveryClient.updateChecklist({
      targetWorkspaceId: "workspace-1", deliveryId: "delivery-1", checklistKey: "system_integration",
      items: [{ itemKey: "插件账号", completed: true, evidence: "已核验", evidenceAssetRefs: ["asset:integration"] }],
      expectedRevision: 3,
    }, signal);
    expect(rpc).toHaveBeenCalledWith("ops.customer-delivery.checklist.update", expect.objectContaining({
      target_workspace_id: "workspace-1", delivery_id: "delivery-1", expected_revision: "3",
    }), { signal, timeoutMs: 120_000 });
  });
  it("fails closed when the video list response is missing", () => {
    expect(() => parseCustomerDeliveryVideos(null)).toThrow("客户交付视频接口返回了无效响应");
    expect(() => parseCustomerDeliveryVideos({})).toThrow("客户交付视频接口返回了无效响应");
  });

  it("round trips all checklist evidence in structured JSON without confusing notes with attachments", () => {
    const params = buildChecklistUpdateParams({
      targetWorkspaceId: "workspace-1", deliveryId: "delivery-1", checklistKey: "functional_acceptance", expectedRevision: 4,
      items: [{ itemKey: "文案生成", completed: true, evidence: '链接 "https://example.test"\n第二行', evidenceAssetRefs: [" asset:acceptance ", "asset:acceptance"] }],
    });
    expect(JSON.parse(params.items_json)).toEqual([{ itemKey: "文案生成", completed: true, evidence: { note: '链接 "https://example.test"\n第二行', asset_refs: ["asset:acceptance"] } }]);
    expect(parseCustomerDeliveryChecklistItems({ items: JSON.parse(params.items_json) })).toEqual([{ itemKey: "文案生成", completed: true, evidence: '链接 "https://example.test"\n第二行', evidenceAssetRefs: ["asset:acceptance"] }]);
  });

  it("parses encoded evidence JSON and keeps an attachment-only note empty", () => {
    expect(parseCustomerDeliveryChecklistItems({ items: [{ item_key: "插件账号", completed: true, evidence_json: '{"asset_refs":["asset:integration"]}' }] })).toEqual([{ itemKey: "插件账号", completed: true, evidence: "", evidenceAssetRefs: ["asset:integration"] }]);
    expect(() => parseCustomerDeliveryChecklistItems({ items: [{ itemKey: "插件账号", completed: true, evidence_json: "{" }] })).toThrow("JSON 无效");
    expect(() => parseCustomerDeliveryChecklistItems({ items: [{ itemKey: "插件账号", completed: true, evidence: { note: 7, asset_refs: [] } }] })).toThrow("凭证说明无效");
  });

  it("preserves payment, training and per-item evidence in aggregate responses", () => {
    expect(parseCustomerDeliveryList({ items: [{ ...delivery, payment_evidence_refs: ["asset:payment"], training_evidence_refs: ["asset:training"], integrationEvidenceAssetRefs: { 插件账号: ["asset:integration"] }, acceptanceEvidenceAssetRefs: { 文案生成: ["asset:acceptance"] } }] })[0]).toMatchObject({ paymentEvidenceRefs: ["asset:payment"], trainingEvidenceRefs: ["asset:training"], integrationEvidenceAssetRefs: { 插件账号: ["asset:integration"] }, acceptanceEvidenceAssetRefs: { 文案生成: ["asset:acceptance"] } });
  });

  it("does not silently drop malformed evidence and later overwrite the saved set", () => {
    for (const refs of ["asset:existing", ["asset:existing", 7], [" "], ["https://example.test/file"], ["asset:invalid ref"]]) {
      expect(() => parseCustomerDeliveryEvidenceRefs(refs)).toThrow("有效素材编号数组");
      expect(() => parseCustomerDeliveryList({ items: [{ ...delivery, paymentEvidenceRefs: refs }] })).toThrow("付款凭证");
      expect(() => parseCustomerDeliveryList({ items: [{ ...delivery, trainingEvidenceRefs: refs }] })).toThrow("培训凭证");
      expect(() => parseCustomerDeliveryChecklistItems([{ itemKey: "插件账号", completed: true, evidence: { asset_refs: refs } }])).toThrow("交付凭证");
    }
    expect(parseCustomerDeliveryEvidenceRefs(undefined)).toEqual([]);
    expect(parseCustomerDeliveryEvidenceRefs(null)).toEqual([]);
    expect(parseCustomerDeliveryEvidenceRefs([])).toEqual([]);
  });

  it("sends an explicit evidence array when confirming and cancelling training", async () => {
    vi.mocked(rpc).mockResolvedValue(delivery);
    const signal = new AbortController().signal;
    await customerDeliveryClient.completeTraining({ targetWorkspaceId: "workspace-1", deliveryId: "cd_1", completed: true, expectedRevision: 4, evidenceAssetRefs: ["asset:training"] }, signal);
    expect(rpc).toHaveBeenLastCalledWith("ops.customer-delivery.training.complete", { target_workspace_id: "workspace-1", delivery_id: "cd_1", completed: "true", expected_revision: "4", evidence_refs_json: '["asset:training"]' }, { signal });
    await customerDeliveryClient.completeTraining({ targetWorkspaceId: "workspace-1", deliveryId: "cd_1", completed: false, expectedRevision: 5, evidenceAssetRefs: [] });
    expect(rpc).toHaveBeenLastCalledWith("ops.customer-delivery.training.complete", expect.objectContaining({ completed: "false", evidence_refs_json: "[]" }), { signal: undefined });
  });
});
