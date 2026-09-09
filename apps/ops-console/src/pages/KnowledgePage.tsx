import { Alert, Button } from "antd";
import { OpsPage } from "../components/OpsPage";
import { OpsPageError } from "../components/OpsPageError";
import { KnowledgeGovernanceSection } from "../components/tasks/KnowledgeGovernanceSection";
import type { OpsConsoleModel } from "../hooks/useOpsConsoleModel";

interface KnowledgePageProps {
  model: OpsConsoleModel;
}

/** The knowledge base is a first-class workspace surface, not a task sub-panel. */
export function KnowledgePage({ model }: KnowledgePageProps) {
  const error = model.dataSetError(
    "knowledge.rule.list",
    "knowledge.asset.list",
    "knowledge.learning.list",
    "knowledge.competitor.list",
  );
  return (
    <OpsPage
      eyebrow="WORKSPACE KNOWLEDGE"
      title="知识库"
      description="把已核验的品牌资产、运营规则、人工反馈和竞品观察沉淀为可追溯的工作区记忆，并安全提供给 ChatGPT 插件使用。"
      actions={<Button type="primary" loading={model.loading} onClick={() => void model.load()}>刷新知识库</Button>}
      nextStep={error ? "先修复知识数据读取问题；空列表不能解释为知识库没有内容。" : "先处理待审核资产，再确认规则和学习建议，最后让插件在下一次任务中引用已确认知识。"}
    >
      <div className="ops-knowledge-page">
        <OpsPageError error={error ?? ""} onRetry={() => void model.load()} />
        <Alert
          showIcon
          type="info"
          title="插件学习闭环已接入"
          description="只使用当前工作区、已确认且有来源的知识；反馈会先进入学习建议，人工确认后才会影响后续生成。"
        />
        <KnowledgeGovernanceSection model={model} title="知识库内容与治理" />
      </div>
    </OpsPage>
  );
}
