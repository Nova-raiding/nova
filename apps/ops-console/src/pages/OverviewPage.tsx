import { OpsPage } from "../components/OpsPage";
import { OpsPageError } from "../components/OpsPageError";
import { CommercialOverviewSection } from "../components/sections/overview/CommercialOverviewSection";
import { DataReadinessSection } from "../components/sections/overview/DataReadinessSection";
import { ModelServiceSummary } from "../components/models/ModelServiceSummary";
import { PlatformReadinessSection } from "../components/sections/overview/PlatformReadinessSection";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";
import type { OpsDomain } from "../navigation/opsNavigation";

interface OverviewPageProps {
  model: OpsConsoleModel;
  onNavigate: (domain: OpsDomain) => void;
}

export function OverviewPage({ model, onNavigate }: OverviewPageProps) {
  return (
    <OpsPage
      eyebrow="OVERVIEW"
      title="运营总览"
      description="查看套餐、模型、平台告警和上线状态。"
    >
      <OpsPageError error={model.error} onRetry={() => void model.load()} />
      <CommercialOverviewSection model={model} />
      <ModelServiceSummary
        status={model.modelStatus}
        loading={model.modelStatusLoading}
        onOpen={() => onNavigate("models")}
      />
      <PlatformReadinessSection model={model} />
      <DataReadinessSection model={model} />
    </OpsPage>
  );
}
