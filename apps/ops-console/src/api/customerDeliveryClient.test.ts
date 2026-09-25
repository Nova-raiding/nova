import { afterEach, describe, expect, it, vi } from "vitest";
import { buildChecklistUpdateParams, customerDeliveryClient, parseCustomerDeliveryAccountBinding, parseCustomerDeliveryAccounts, parseCustomerDeliveryChecklistItems, parseCustomerDeliveryEvidenceRefs, parseCustomerDeliveryList, parseCustomerDeliveryVideos, validateCustomerDeliveryContractUrl } from "./customerDeliveryClient.js";
import { rpc } from "./opsClient.js";

vi.mock("./opsClient.js", () => ({ rpc: vi.fn() }));
afterEach(() => vi.clearAllMocks());
const delivery = { id: "cd_1", companyName: "Acme", paymentStatus: "paid", profile: true, integration: true, acceptance: true, training: false, videos: 0 };
const deliveryPage = (items: unknown[]) => ({ items, total: items.length, offset: 0, limit: 20, hasMore: false, project_owner_options: [], support_owner_options: [] });

describe("customer delivery client", () => {
  const account = { workspaceId: "workspace-1", accountId: "account-1", identityId: "identity-1", login: "merchant@example.test" };
  const bindInput = { targetWorkspaceId: "workspace-1", deliveryId: "cd_1", targetAccountId: "account-1", expectedRevision: 4, reason: "核验账号后关联" };
  const bound = { ...delivery, workspaceId: "workspace-1", revision: 5, targetAccountId: account.accountId, targetIdentityId: account.identityId, targetAccountLogin: account.login };
  it("parses legacy unbound records without interpreting completion as account activation", () => {
    expect(parseCustomerDeliveryAccountBinding({ effectiveAt: "2026-09-15T00:00:00Z" })).toEqual({ targetAccountId: null, targetIdentityId: null, targetAccountLogin: null });
    expect(parseCustomerDeliveryAccountBinding({ targetAccountId: null, targetIdentityId: null, targetAccountLogin: null })).toEqual({ targetAccountId: null, targetIdentityId: null, targetAccountLogin: null });
    expect(parseCustomerDeliveryList(deliveryPage([bound])).items[0]).toMatchObject({ targetAccountId: account.accountId, targetIdentityId: account.identityId, targetAccountLogin: account.login });
  });
  it.each([
    { targetAccountId: "account-1" }, { targetIdentityId: "identity-1" }, { targetAccountLogin: "merchant@example.test" },
    { targetAccountId: "account-1", targetIdentityId: "identity-1", targetAccountLogin: "" },
    { targetAccountId: "account-1", targetIdentityId: null, targetAccountLogin: "merchant@example.test" },
    { targetAccountId: 2, targetIdentityId: "identity-1", targetAccountLogin: "merchant@example.test" },
  ])("rejects partial or malformed account linkage %j", (input) => {
    expect(() => parseCustomerDeliveryAccountBinding(input)).toThrow("关联信息不完整");
  });
  it("queries an explicitly scoped, paged account directory without writing", async () => {
    vi.mocked(rpc).mockResolvedValue({ items: [account], nextCursor: "page-2" });
    const signal = new AbortController().signal;
    await expect(customerDeliveryClient.listAccounts({ targetWorkspaceId: "workspace-1", search: " merchant ", cursor: "page-1", limit: 50 }, signal)).resolves.toEqual({ items: [account], nextCursor: "page-2" });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("ops.customer-delivery.accounts.list", { target_workspace_id: "workspace-1", search: "merchant", cursor: "page-1", limit: "50" }, { signal });
  });
  it("requests one bounded delivery page with server filters and rejects inconsistent metadata", async () => {
    vi.mocked(rpc).mockResolvedValue({ items: [delivery], total: 21, offset: 20, limit: 20, hasMore: false, project_owner_options: ["API 销售甲"], support_owner_options: ["API 售后乙"] });
    await expect(customerDeliveryClient.list({ targetWorkspaceId: "workspace-1", offset: 20, limit: 20, query: " Acme ", projectOwner: " 姜伟 " })).resolves.toMatchObject({ total: 21, offset: 20, items: [expect.objectContaining({ id: "cd_1" })], projectOwnerOptions: ["API 销售甲"], supportOwnerOptions: ["API 售后乙"] });
    expect(rpc).toHaveBeenCalledWith("ops.customer-delivery.list", { target_workspace_id: "workspace-1", query: "Acme", project_owner: "姜伟", offset: "20", limit: "20" }, { signal: undefined });
    vi.mocked(rpc).mockResolvedValue({ items: [], total: 21, offset: 0, limit: 20, hasMore: false, project_owner_options: [], support_owner_options: [] });
    await expect(customerDeliveryClient.list({ targetWorkspaceId: "workspace-1" })).rejects.toThrow("分页");
  });
  it("requires server owner option arrays and preserves empty arrays as empty", () => {
    expect(parseCustomerDeliveryList(deliveryPage([]))).toMatchObject({ projectOwnerOptions: [], supportOwnerOptions: [] });
    expect(() => parseCustomerDeliveryList({ ...deliveryPage([]), project_owner_options: undefined })).toThrow("分页");
    expect(() => parseCustomerDeliveryList({ ...deliveryPage([]), support_owner_options: [""] })).toThrow("分页");
  });
  it.each([null, {}, { items: null }, { items: [], nextCursor: "" }, { items: [{ ...account, workspaceId: "other" }] }, { items: [{ ...account, login: "" }] }, { items: [account, account] }, { items: [account, { ...account, accountId: "other" }] }])("rejects unsafe directory responses %j", (value) => {
    expect(() => parseCustomerDeliveryAccounts(value, "workspace-1")).toThrow();
  });
  it.each([0, 51, 1.2, Number.NaN])("rejects invalid account page sizes %s", async (limit) => {
    await expect(customerDeliveryClient.listAccounts({ targetWorkspaceId: "workspace-1", limit })).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
  it("sends only the explicit binding and validates its new revision", async () => {
    vi.mocked(rpc).mockResolvedValue(bound);
    const signal = new AbortController().signal;
    await expect(customerDeliveryClient.bindAccount(bindInput, signal)).resolves.toMatchObject({ targetAccountLogin: account.login, revision: 5 });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("ops.customer-delivery.account.bind", { target_workspace_id: "workspace-1", delivery_id: "cd_1", target_account_id: "account-1", expected_revision: "4", reason: bindInput.reason }, { signal });
  });
  it.each([{ id: "other" }, { workspaceId: "other" }, { workspaceId: undefined }, { targetAccountId: "other" }, { revision: 4 }, { revision: undefined }, { targetAccountLogin: null }])("rejects mismatched binding results %j", async (patch) => {
    vi.mocked(rpc).mockResolvedValue({ ...bound, ...patch });
    await expect(customerDeliveryClient.bindAccount(bindInput)).rejects.toThrow();
  });
  it("rejects invalid reasons and aborted/late account requests", async () => {
    await expect(customerDeliveryClient.bindAccount({ ...bindInput, reason: "短" })).rejects.toThrow("3–1000");
    expect(rpc).not.toHaveBeenCalled();
    for (const run of [customerDeliveryClient.listAccounts.bind(null, { targetWorkspaceId: "workspace-1" }), customerDeliveryClient.bindAccount.bind(null, bindInput)]) {
      const controller = new AbortController();
      vi.mocked(rpc).mockImplementation(async () => { controller.abort(); return bound; });
      await expect(run(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
      vi.mocked(rpc).mockClear();
      await expect(run(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
      expect(rpc).not.toHaveBeenCalled();
    }
  });
  it("imports a contract URL with only the scoped source fields and reuses the asset response", async () => {
    const asset = { assetRef: "asset:contract-import", name: "contract.pdf", mimeType: "application/pdf", sizeBytes: 100, scanStatus: "pending", ready: false };
    vi.mocked(rpc).mockResolvedValue(asset);
    const signal = new AbortController().signal;
    await expect(customerDeliveryClient.uploadAsset({ targetWorkspaceId: "workspace-1", deliveryId: "cd_1", purpose: "contract", sourceUrl: "  https://files.example.test/contract.pdf?token=example  " }, signal)).resolves.toEqual(asset);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("ops.customer-delivery.assets.upload", {
      target_workspace_id: "workspace-1", delivery_id: "cd_1", purpose: "contract", source_url: "https://files.example.test/contract.pdf?token=example",
    }, { signal, timeoutMs: 120_000 });
  });

  it.each(["", "not-a-url", "http://example.test/file.pdf", "https://example.test:8443/file.pdf", "https://user:pass@example.test/file.pdf", "https://example.test/file.pdf#page=2", "https://example.test/file.pdf#", "https://example.test/a b.pdf", "https://example.test/a\\b.pdf", "https://example.test/a\n.pdf", "https://example.test/a\u200b.pdf"])("rejects an invalid contract URL before sending it: %j", async (sourceUrl) => {
    await expect(customerDeliveryClient.uploadAsset({ targetWorkspaceId: "workspace-1", deliveryId: "cd_1", purpose: "contract", sourceUrl })).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("allows HTTPS default-port file URLs without guessing MIME or stripping signed query bytes", () => {
    const source = "https://files.example.test:443/download?name=contract%2Epdf&signature=a%2Bb";
    expect(validateCustomerDeliveryContractUrl(` ${source} `)).toBe(source);
  });

  it("rejects oversized links without truncating signatures, empty userinfo and encoded controls", () => {
    const exact = "https://files.example.test/file.pdf?signature=".padEnd(2000, "a");
    expect(exact.length).toBe(2000);
    expect(validateCustomerDeliveryContractUrl(exact)).toBe(exact);
    expect(() => validateCustomerDeliveryContractUrl(`${exact}b`)).toThrow("2000");
    for (const value of ["https:example.test/file.pdf", "https://@example.test/file.pdf", "https://example.test/file%0a.pdf", "https://example.test/file%00.pdf", "https://example.test/file%7F.pdf", "https://example.test/file%5c.pdf"]) {
      expect(() => validateCustomerDeliveryContractUrl(value)).toThrow();
    }
  });

  it.each([
    { purpose: "video", sourceUrl: "https://example.test/file.mp4" },
    { purpose: "contract", sourceUrl: "https://example.test/file.pdf", file: new File(["pdf"], "file.pdf") },
    { purpose: "contract" },
    { purpose: "contract", sourceUrl: undefined },
  ])("rejects ambiguous, missing or non-contract URL sources at runtime", async (source) => {
    const input = { targetWorkspaceId: "workspace-1", deliveryId: "cd_1", ...source } as Parameters<typeof customerDeliveryClient.uploadAsset>[0];
    await expect(customerDeliveryClient.uploadAsset(input)).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("does not accept a late URL import after cancellation or an untrusted scan response", async () => {
    const input = { targetWorkspaceId: "workspace-1", deliveryId: "cd_1", purpose: "contract" as const, sourceUrl: "https://example.test/file.pdf" };
    const controller = new AbortController();
    vi.mocked(rpc).mockImplementation(async () => { controller.abort(); return {}; });
    await expect(customerDeliveryClient.uploadAsset(input, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    vi.mocked(rpc).mockResolvedValue({ assetRef: "https://example.test/file.pdf", ready: true });
    await expect(customerDeliveryClient.uploadAsset(input)).rejects.toThrow("安全检查状态");
    vi.mocked(rpc).mockClear();
    await expect(customerDeliveryClient.uploadAsset(input, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("parses aggregate snake_case response", () => {
    expect(parseCustomerDeliveryList(deliveryPage([{ id: "cd_1", company_name: "Acme", payment_status: "paid", customerProfileStatus: "complete", systemIntegrationStatus: "complete", functionalAcceptanceStatus: "incomplete", trainingCompleted: false, videos: [{ id: "v" }], created_at: "2026-09-16T00:01:02.000Z" }])).items).toMatchObject([{ id: "cd_1", companyName: "Acme", paymentStatus: "paid", profile: true, integration: true, acceptance: false, training: false, videos: 1, createdAt: "2026-09-16T00:01:02.000Z" }]);
  });
  it("rejects malformed rows instead of returning empty state", () => {
    expect(() => parseCustomerDeliveryList(deliveryPage([{ id: "cd_1" }]))).toThrow("客户交付接口返回了无效响应");
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
    expect(parseCustomerDeliveryList(deliveryPage([{ ...delivery, payment_evidence_refs: ["asset:payment"], training_evidence_refs: ["asset:training"], integrationEvidenceAssetRefs: { 插件账号: ["asset:integration"] }, acceptanceEvidenceAssetRefs: { 文案生成: ["asset:acceptance"] } }])).items[0]).toMatchObject({ paymentEvidenceRefs: ["asset:payment"], trainingEvidenceRefs: ["asset:training"], integrationEvidenceAssetRefs: { 插件账号: ["asset:integration"] }, acceptanceEvidenceAssetRefs: { 文案生成: ["asset:acceptance"] } });
  });

  it("does not silently drop malformed evidence and later overwrite the saved set", () => {
    for (const refs of ["asset:existing", ["asset:existing", 7], [" "], ["https://example.test/file"], ["asset:invalid ref"]]) {
      expect(() => parseCustomerDeliveryEvidenceRefs(refs)).toThrow("有效素材编号数组");
      expect(() => parseCustomerDeliveryList(deliveryPage([{ ...delivery, paymentEvidenceRefs: refs }]))).toThrow("付款凭证");
      expect(() => parseCustomerDeliveryList(deliveryPage([{ ...delivery, trainingEvidenceRefs: refs }]))).toThrow("培训凭证");
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
