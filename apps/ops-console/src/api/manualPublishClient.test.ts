import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("./opsClient.js", () => ({ rpc }));
const { manualPublishClient } = await import("./manualPublishClient.js");

const input = {
  targetWorkspaceId: "workspace-1",
  publishJobId: "publish-1", taskId: "task-1", contentVersionId: "content-1", platform: "douyin", accountId: "account-1", expectedRevision: 1, status: "manual_publish_reported" as const,
  deliveryBundleHash: "a".repeat(64), platformItemId: "remote-1", publicUrl: "https://example.com/item/1",
  evidenceKind: "screenshot" as const, evidenceReference: "asset:evidence-1", note: "运营提交后截图",
  idempotencyKey: "idem-1",
};

describe("manual publish client", () => {
  beforeEach(() => rpc.mockReset());

  it("fails closed when the server has not advertised a write capability", async () => {
    await expect(manualPublishClient.recordEvidence(input, null)).rejects.toThrow("尚未提供");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("uses the advertised typed method and never permits platform_verified", async () => {
    rpc.mockResolvedValue({ status: "manual_publish_reported", evidence: [] });
    await manualPublishClient.recordEvidence(input, { method: "ops.marketing.publish.manual-evidence.record", writable: true });
    expect(rpc).toHaveBeenCalledWith("ops.marketing.publish.manual-evidence.record", expect.objectContaining({
      target_workspace_id: "workspace-1", task_id: "task-1", content_version_id: "content-1", platform: "douyin", account_id: "account-1", expected_revision: "1", status: "manual_publish_reported",
      evidence_refs_json: JSON.stringify(["asset:evidence-1"]), idempotency_key: "idem-1",
    }), { signal: undefined });
  });

  it("does not report success when the server returns an empty result", async () => {
    rpc.mockResolvedValue(null);
    await expect(manualPublishClient.recordEvidence(input, { method: "ops.marketing.publish.manual-evidence.record", writable: true })).rejects.toThrow("未返回持久化后的");
  });
});
