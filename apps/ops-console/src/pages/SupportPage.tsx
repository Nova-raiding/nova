import { Alert, Button } from "antd";
import { OpsPage } from "../components/OpsPage.js";
import { SupportCrmExportSection } from "../components/support/SupportCrmExportSection.js";
import { SupportQueueSection } from "../components/support/SupportQueueSection.js";
import { SupportTicketDetailSection } from "../components/support/SupportTicketDetailSection.js";
import { SupportSlaReportSection } from "../components/support/SupportSlaReportSection.js";
import type { SupportDomainModel } from "../hooks/useSupportDomain.js";
import { useEffect, useId, useRef } from "react";

export function SupportPage({ model }: { model: SupportDomainModel }) {
  const initialLoadFailed = Boolean(model.error && !model.loading && model.tickets.length === 0);
  const errorRef = useRef<HTMLDivElement>(null);
  const errorTitleId = useId();
  const errorDescriptionId = useId();
  useEffect(() => {
    if (model.error) errorRef.current?.focus({ preventScroll: true });
  }, [model.error]);
  return (
    <OpsPage
      eyebrow="SUPPORT CRM"
      title="客服与客户关系"
      description="处理客户工单、保留不可变事件历史，并按租户受控导出 CRM 客户投影。"
    >
      {model.error && <div ref={errorRef} tabIndex={-1} role="alert" aria-labelledby={errorTitleId} aria-describedby={errorDescriptionId}>
        <Alert
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
          type="error"
          showIcon
          title={<span id={errorTitleId}>客服操作失败</span>}
          description={<span id={errorDescriptionId}>{model.error}</span>}
          action={<Button htmlType="button" style={{ minHeight: 44 }} aria-label="重试客服数据" onClick={() => void model.reload()}>重试</Button>}
        />
      </div>}
      <SupportQueueSection model={model} />
      {!initialLoadFailed ? <SupportSlaReportSection model={model} /> : null}
      {!initialLoadFailed ? <SupportTicketDetailSection model={model} /> : null}
      {!initialLoadFailed ? <SupportCrmExportSection onExport={model.exportCrm} /> : null}
    </OpsPage>
  );
}
