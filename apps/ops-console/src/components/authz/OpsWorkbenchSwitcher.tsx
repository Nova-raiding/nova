import { Tag } from "antd";
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
  available,
}: {
  value: OpsWorkbench;
  available: readonly OpsWorkbench[];
  switching?: boolean;
  onChange?: (workbench: OpsWorkbench) => void;
}) {
  // The Ops Console is the platform-operations surface. Merchant operation
  // belongs to Merchant Studio and must not appear as a second top-level tab
  // here, even when the server session advertises both workbench contracts.
  const candidates = [...new Set(available)].filter(
    (candidate): candidate is OpsWorkbench => candidate === "platform",
  );
  return <Tag color="blue">{labels[candidates[0] ?? "platform"]}</Tag>;
}
