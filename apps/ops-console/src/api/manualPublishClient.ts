import { rpc } from "./opsClient.js";
import type { ManualPublishRecord, ManualPublishStatus } from "../types/ops.js";

export type RecordManualPublishEvidenceInput = {
  targetWorkspaceId: string;
  publishJobId: string;
  taskId: string;
  contentVersionId: string;
  platform: string;
  accountId: string;
  expectedRevision: number;
  status: Exclude<ManualPublishStatus, "platform_verified">;
  deliveryBundleHash: string;
  platformItemId?: string;
  publicUrl?: string;
  evidenceKind: "screenshot" | "public_url" | "platform_record" | "review_note";
  evidenceReference: string;
  note: string;
  idempotencyKey: string;
};

export const manualPublishClient = {
  async recordEvidence(
    input: RecordManualPublishEvidenceInput,
    capability: ManualPublishRecord["writeCapability"],
    signal?: AbortSignal,
  ): Promise<ManualPublishRecord> {
    if (capability?.writable !== true || capability.method !== "ops.marketing.publish.manual-evidence.record") {
      throw new Error(capability?.blockingReason || "服务端尚未提供人工发布证据写入契约");
    }
    const result = await rpc<ManualPublishRecord>(capability.method, {
      target_workspace_id: input.targetWorkspaceId,
      task_id: input.taskId,
      content_version_id: input.contentVersionId,
      platform: input.platform,
      account_id: input.accountId,
      expected_revision: String(input.expectedRevision),
      status: input.status,
      delivery_bundle_hash: input.deliveryBundleHash,
      occurred_at: new Date().toISOString(),
      ...(input.platformItemId ? { remote_content_id: input.platformItemId } : {}),
      ...(input.publicUrl ? { public_url: input.publicUrl } : {}),
      evidence_refs_json: JSON.stringify([input.evidenceReference]),
      differences_json: input.status === "manual_review_required" ? JSON.stringify([{ kind: input.evidenceKind, note: input.note }]) : "[]",
      reason: input.note,
      idempotency_key: input.idempotencyKey,
    }, { signal });
    if (!result) throw new Error("服务端未返回持久化后的人工发布记录");
    return result;
  },
};
