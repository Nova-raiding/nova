import { DownloadOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Typography } from "antd";
import { useState } from "react";
import type { SupportCrmExportContract } from "../../../../../packages/contracts/src/ops/support.js";

export function csvCell(value: unknown): string {
  const raw = String(value ?? "");
  const safe = /^[\t\r ]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

function downloadCsv(data: SupportCrmExportContract) {
  const rows = data.rows.map(row => [row.customerId, row.customerName, row.customerEmail, row.totalTickets, row.openTickets, row.urgentTickets, row.lastTicketAt, row.lastTicketStatus]);
  const csv = `\uFEFF${[data.columns, ...rows].map(row => row.map(csvCell).join(",")).join("\n")}`;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `support-crm-${data.workspaceId}-${data.generatedAt.slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function SupportCrmExportSection({ onExport }: { onExport: () => Promise<SupportCrmExportContract> }) {
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState("");

  const run = async () => {
    setExporting(true); setMessage("");
    try { const data = await onExport(); downloadCsv(data); setMessage(`已导出 ${data.rows.length} 条客户投影。`); }
    catch (error) { setMessage(error instanceof Error ? error.message : "CRM 导出失败，请重试。"); }
    finally { setExporting(false); }
  };

  return (
    <Card title="CRM 客户投影与导出" extra={<Button icon={<DownloadOutlined aria-hidden="true" />} loading={exporting} onClick={() => void run()}>导出 CSV</Button>}>
      <Typography.Paragraph type="secondary">导出仅包含客户维度工单统计，不包含内部备注和事件原文；服务端仍会执行平台运营权限和租户范围校验。</Typography.Paragraph>
      {message && <Alert role="status" type={message.startsWith("已导出") ? "success" : "error"} showIcon title={message} />}
    </Card>
  );
}
