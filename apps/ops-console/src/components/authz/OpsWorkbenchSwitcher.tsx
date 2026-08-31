import { Segmented, Tag, Typography } from "antd";
import type { OpsWorkbench } from "../../types/ops.js";

const labels: Record<OpsWorkbench, string> = {
  platform: "平台控制台",
  workspace: "商家工作区",
};

export function OpsWorkbenchSwitcher({
  value,
  available,
  switching = false,
  onChange,
}: {
  value: OpsWorkbench;
  available: readonly OpsWorkbench[];
  switching?: boolean;
  onChange?: (workbench: OpsWorkbench) => void;
}) {
  const candidates = [...new Set(available)].filter(
    (candidate): candidate is OpsWorkbench => candidate === "platform" || candidate === "workspace",
  );
  if (candidates.length < 2) {
    return <Tag color="blue">{labels[candidates[0] ?? value]}</Tag>;
  }
  return (
    <span aria-label="切换运营工作台" aria-busy={switching}>
      <Typography.Text type="secondary">工作台 </Typography.Text>
      <Segmented<OpsWorkbench>
        aria-label="当前运营工作台"
        value={value}
        options={candidates.map((candidate) => ({ label: labels[candidate], value: candidate }))}
        disabled={switching}
        onChange={(next) => { if (next !== value) onChange?.(next); }}
      />
    </span>
  );
}
