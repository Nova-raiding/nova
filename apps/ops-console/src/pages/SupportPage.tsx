import { Alert, Button } from "antd";
import { OpsPage } from "../components/OpsPage.js";
import { OpsPageError } from "../components/OpsPageError.js";
import { SupportQueueSection } from "../components/support/SupportQueueSection.js";
import { SupportTicketDetailSection } from "../components/support/SupportTicketDetailSection.js";
import { SupportSlaReportSection } from "../components/support/SupportSlaReportSection.js";
import type { SupportDomainModel } from "../hooks/useSupportDomain.js";

export function SupportPage({ model }: { model: SupportDomainModel }) {
  const initialLoadFailed = Boolean(model.error && !model.loading && model.tickets.length === 0);
  return (
    <OpsPage
      eyebrow="CUSTOMER SUPPORT"
      title="客服工作台"
      description="围绕客户问题、任务异常和发布风险处理工单，保留可审计的处理时间线与 SLA 证据。"
      actions={<Button type="primary" loading={model.loading} onClick={() => void model.reload()}>刷新客服</Button>}
    >
      <OpsPageError error={model.error ?? ""} onRetry={() => void model.reload()} />
      <Alert
        type="info"
        showIcon
        title="客服处理顺序"
        description="从任务、生成、发布或订单异常进入客服后，先关联任务/订单，再分配负责人；所有沟通写入工单事件，按 SLA 跟踪，确认客户可见回复后再解决或关闭。"
        style={{ marginBottom: 16 }}
      />
      <SupportQueueSection model={model} />
      {!initialLoadFailed ? <SupportSlaReportSection model={model} /> : null}
      {!initialLoadFailed ? <SupportTicketDetailSection model={model} /> : null}
    </OpsPage>
  );
}
