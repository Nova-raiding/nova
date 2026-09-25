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
  // Scope the error to the two datasets this page actually reads. The console
  // level `model.error` is reused across semantics: it is written by any
  // failing optional dataset and cleared whenever `loadRules` succeeds, so
  // using it here both mislabels unrelated outages as rule-sync failures and
  // erases the global staleness warning after a successful rule refresh.
  const ruleError = model.dataSetError("rule.list", "rule.sync.status");
  return (
    <OpsPage
      eyebrow="PLATFORM RULES"
      title="平台规则"
      description="查看六个平台规则同步新鲜度，维护规则生命周期，并保留来源与审批证据。"
      actions={<Button type="primary" loading={model.ruleSyncLoading} onClick={() => void model.loadRules()}>刷新规则</Button>}
    >
      <div className="ops-rules-page">
      <OpsPageError error={ruleError} onRetry={() => void model.loadRules()} />
      <Alert
        type="info"
        showIcon
        title="平台规则支持自动同步或人工上传"
        description="签名清单用于自动同步；运营也可以上传带有官方依据的 Markdown，系统会先生成待审核草稿。人工草稿在独立审批并激活前不会进入商家插件，也不会被当作已验证规则。"
        style={{ marginBottom: 16 }}
      />
      <RuleSyncStatusSection
        loading={model.ruleSyncLoading}
        statuses={model.ruleSyncStatuses}
        error={ruleError}
        onRefresh={() => void model.loadRules()}
        canSync={model.canRules}
        onSyncNow={() => void model.syncRulesNow()}
      />
      <RuleCenterSection model={model} />
      <WorkspaceRuleAuditPanel />
      </div>
    </OpsPage>
  );
}
