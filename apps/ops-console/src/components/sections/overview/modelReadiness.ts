import type { ModelStatus } from "../../../types/ops.js";

const capabilities = [
  { key: "text", label: "文案" },
  { key: "image", label: "图片" },
  { key: "image_edit", label: "局部编辑" },
  { key: "ocr", label: "OCR" },
  { key: "video", label: "视频" },
] as const;

export type ModelReadinessRow = {
  key: string;
  label: string;
  providerConfigured: boolean;
  ready: boolean;
  reasons: string[];
};

export function modelStateLabel(state: string | undefined): string {
  return ({
    ready: "已就绪",
    blocked: "已阻断",
    unavailable: "不可用",
    unknown: "状态待确认",
    degraded: "服务降级",
  } as Record<string, string>)[state ?? ""] ?? "状态待确认";
}

export function modelReadinessRows(
  status: Pick<ModelStatus, "model_readiness" | "state"> | undefined,
): ModelReadinessRow[] {
  if (!status) return [];
  return capabilities.map(({ key, label }) => {
    const readiness = status?.model_readiness?.[key];
    return {
      key,
      label,
      providerConfigured: readiness?.provider_configured === true,
      // Fail closed: provider configuration alone never means the capability
      // passed its final runtime and commercial readiness gates.
      ready: status.state === "ready" && readiness?.ready === true,
      reasons: status.state === "ready"
        ? readiness?.reasons ?? []
        : readiness?.reasons?.length
          ? readiness.reasons
          : [`平台模型最终状态为 ${modelStateLabel(status.state)}，尚未通过上线门禁`],
    };
  });
}

const costBlockerPattern = /成本|计费|价格|人民币|分组|额度/u;

export function modelCostReadiness(
  status:
    | Pick<
        ModelStatus,
        "cost_control_ready" | "cost_evidence_ready" | "next_actions"
      >
    | undefined,
): { ready: boolean; blockers: string[] } {
  if (!status) return { ready: false, blockers: [] };
  const ready =
    status.cost_control_ready === true && status.cost_evidence_ready === true;
  const blockers = ready
    ? []
    : status.next_actions.filter((action) => costBlockerPattern.test(action));
  return { ready, blockers };
}
