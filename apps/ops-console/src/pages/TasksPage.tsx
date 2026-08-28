import { OpsPage } from "../components/OpsPage";
import { OpsPageError } from "../components/OpsPageError";
import { AlertFiltersSection } from "../components/tasks/AlertFiltersSection";
import { KnowledgeGovernanceSection } from "../components/tasks/KnowledgeGovernanceSection";
import { MarketingQueueFiltersSection } from "../components/tasks/MarketingQueueFiltersSection";
import { RuleCenterSection } from "../components/tasks/RuleCenterSection";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";

interface TasksPageProps {
  model: OpsConsoleModel;
}

export function TasksPage({ model }: TasksPageProps) {
  return (
    <OpsPage
      eyebrow="CONTENT OPERATIONS"
      title="任务与内容"
      description="治理知识、素材、生成任务、平台规则和发布异常。"
    >
      <OpsPageError error={model.error} onRetry={() => void model.load()} />
      <MarketingQueueFiltersSection model={model} />
      <AlertFiltersSection model={model} />
      <KnowledgeGovernanceSection model={model} />
      <RuleCenterSection model={model} />
    </OpsPage>
  );
}
