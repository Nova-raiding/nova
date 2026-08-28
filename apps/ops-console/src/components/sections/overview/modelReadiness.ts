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

export function modelReadinessRows(
  status: Pick<ModelStatus, "model_readiness"> | undefined,
): ModelReadinessRow[] {
  return capabilities.map(({ key, label }) => {
    const readiness = status?.model_readiness?.[key];
    return {
      key,
      label,
      providerConfigured: readiness?.provider_configured === true,
      // Fail closed: provider configuration alone never means the capability
      // passed its final runtime and commercial readiness gates.
      ready: readiness?.ready === true,
      reasons: readiness?.reasons ?? [],
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
