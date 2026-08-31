import { Alert, Button } from "antd";
import { OpsPage } from "../components/OpsPage.js";
import { SupportCrmExportSection } from "../components/support/SupportCrmExportSection.js";
import { SupportQueueSection } from "../components/support/SupportQueueSection.js";
import { SupportTicketDetailSection } from "../components/support/SupportTicketDetailSection.js";
import type { SupportDomainModel } from "../hooks/useSupportDomain.js";

export function SupportPage({ model }: { model: SupportDomainModel }) {
  const initialLoadFailed = Boolean(model.error && !model.loading && model.tickets.length === 0);
  return (
    <OpsPage
      eyebrow="SUPPORT CRM"
      title="客服与客户关系"
      description="处理客户工单、保留不可变事件历史，并按租户受控导出 CRM 客户投影。"
    >
      {model.error && <Alert role="alert" type="error" showIcon title="客服操作失败" description={model.error} action={<Button style={{ minHeight: 44 }} onClick={() => void model.reload()}>重试</Button>} />}
      <SupportQueueSection model={model} />
      {!initialLoadFailed ? <SupportTicketDetailSection model={model} /> : null}
      {!initialLoadFailed ? <SupportCrmExportSection onExport={model.exportCrm} /> : null}
    </OpsPage>
  );
}
