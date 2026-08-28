import { OpsPage } from "../components/OpsPage";
import { OpsPageError } from "../components/OpsPageError";
import { CommercialOverviewSection } from "../components/sections/overview/CommercialOverviewSection";
import { DataReadinessSection } from "../components/sections/overview/DataReadinessSection";
import { ModelStatusSection } from "../components/sections/overview/ModelStatusSection";
import { PlatformReadinessSection } from "../components/sections/overview/PlatformReadinessSection";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";

interface OverviewPageProps {
  model: OpsConsoleModel;
}

export function OverviewPage({ model }: OverviewPageProps) {
  return (
    <OpsPage
      eyebrow="OVERVIEW"
      title="运营总览"
      description="查看套餐、模型、平台告警和上线状态。"
    >
      <OpsPageError error={model.error} onRetry={() => void model.load()} />
      <CommercialOverviewSection model={model} />
      <ModelStatusSection model={model} />
      <PlatformReadinessSection model={model} />
      <DataReadinessSection model={model} />
    </OpsPage>
  );
}
