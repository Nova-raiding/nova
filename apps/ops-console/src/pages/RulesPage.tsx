import { OpsPage } from "../components/OpsPage";
import { OpsPageError } from "../components/OpsPageError";
import { RuleCenterSection } from "../components/tasks/RuleCenterSection";
import { RuleSyncStatusSection } from "../components/rules/RuleSyncStatusSection";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";

interface RulesPageProps {
  model: OpsConsoleModel;
}

export function RulesPage({ model }: RulesPageProps) {
  return (
    <OpsPage
      eyebrow="PLATFORM RULES"
      title="平台规则"
      description="查看六个平台规则同步新鲜度，维护规则生命周期，并保留来源与审批证据。"
    >
      <OpsPageError error={model.error} onRetry={() => void model.loadRules()} />
      <RuleSyncStatusSection
        loading={model.ruleSyncLoading}
        statuses={model.ruleSyncStatuses}
        error={model.error}
        onRefresh={() => void model.loadRules()}
      />
      <RuleCenterSection model={model} />
    </OpsPage>
  );
}
