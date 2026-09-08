import { OpsPage } from "../components/OpsPage";
import { OpsPageError } from "../components/OpsPageError";
import { RuleCenterSection } from "../components/tasks/RuleCenterSection";
import { RuleSyncStatusSection } from "../components/rules/RuleSyncStatusSection";
import { WorkspaceRuleAuditPanel } from "../components/rules/WorkspaceRuleAuditPanel";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";
import { Alert, Button } from "antd";

interface RulesPageProps {
  model: OpsConsoleModel;
}

export function RulesPage({ model }: RulesPageProps) {
  return (
    <OpsPage
      eyebrow="PLATFORM RULES"
      title="平台规则"
      description="查看六个平台规则同步新鲜度，维护规则生命周期，并保留来源与审批证据。"
      actions={<Button type="primary" loading={model.ruleSyncLoading} onClick={() => void model.loadRules()}>刷新规则</Button>}
    >
      <OpsPageError error={model.error} onRetry={() => void model.loadRules()} />
      <Alert
        type="info"
        showIcon
        message="平台规则只接受签名清单同步"
        description="页面中的 manual:// 记录是本地演示或人工草稿，不代表任何平台官方规则，也不会作为插件知识。请先配置签名清单地址和验签密钥，再点击“立即更新”。"
        style={{ marginBottom: 16 }}
      />
      <RuleSyncStatusSection
        loading={model.ruleSyncLoading}
        statuses={model.ruleSyncStatuses}
        error={model.error}
        onRefresh={() => void model.loadRules()}
        canSync={model.canKnowledge}
        onSyncNow={() => void model.syncRulesNow()}
      />
      <RuleCenterSection model={model} />
      <WorkspaceRuleAuditPanel />
    </OpsPage>
  );
}
