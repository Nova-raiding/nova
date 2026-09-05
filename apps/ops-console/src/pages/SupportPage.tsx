import { Button } from "antd";
import { OpsPage } from "../components/OpsPage.js";
import { OpsPageError } from "../components/OpsPageError.js";
import { SupportCrmExportSection } from "../components/support/SupportCrmExportSection.js";
import { SupportQueueSection } from "../components/support/SupportQueueSection.js";
import { SupportTicketDetailSection } from "../components/support/SupportTicketDetailSection.js";
import { SupportSlaReportSection } from "../components/support/SupportSlaReportSection.js";
import type { SupportDomainModel } from "../hooks/useSupportDomain.js";

export function SupportPage({ model }: { model: SupportDomainModel }) {
  const initialLoadFailed = Boolean(model.error && !model.loading && model.tickets.length === 0);
  return (
    <OpsPage
      eyebrow="SUPPORT CRM"
      title="客服与客户关系"
      description="处理客户工单、保留不可变事件历史，并按租户受控导出 CRM 客户投影。"
      actions={<Button type="primary" loading={model.loading} onClick={() => void model.reload()}>刷新客服</Button>}
    >
      <OpsPageError error={model.error ?? ""} onRetry={() => void model.reload()} />
      <SupportQueueSection model={model} />
      {!initialLoadFailed ? <SupportSlaReportSection model={model} /> : null}
      {!initialLoadFailed ? <SupportTicketDetailSection model={model} /> : null}
      {!initialLoadFailed ? <SupportCrmExportSection onExport={model.exportCrm} /> : null}
    </OpsPage>
  );
}
