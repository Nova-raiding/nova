import { Segmented, Tag, Typography } from "antd";
import { useEffect, useRef } from "react";
import type { OpsWorkbench } from "../../types/ops.js";

const labels: Record<OpsWorkbench, string> = {
  platform: "平台控制台",
  workspace: "商家工作区",
};

export function focusActiveWorkbenchControl(root: Pick<HTMLElement, "querySelector"> | null) {
  const active = root?.querySelector<HTMLElement>("[role='radio'][aria-checked='true'], input:checked");
  active?.focus({ preventScroll: true });
  return Boolean(active);
}

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
  const rootRef = useRef<HTMLSpanElement>(null);
  const wasSwitching = useRef(switching);
  useEffect(() => {
    if (wasSwitching.current && !switching) focusActiveWorkbenchControl(rootRef.current);
    wasSwitching.current = switching;
  }, [switching]);
  const candidates = [...new Set(available)].filter(
    (candidate): candidate is OpsWorkbench => candidate === "platform" || candidate === "workspace",
  );
  if (candidates.length < 2) {
    return <Tag color="blue">{labels[candidates[0] ?? value]}</Tag>;
  }
  return (
    <span ref={rootRef} aria-label="切换运营工作台" aria-busy={switching}>
      <Typography.Text type="secondary">工作台 </Typography.Text>
      {switching ? <span role="status" aria-live="polite" className="sr-only">正在切换运营工作台，请稍候</span> : null}
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
