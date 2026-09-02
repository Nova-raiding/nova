import { Alert, Button, Card, Col, Row, Statistic, Tag, Typography } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { useEffect, useId, useRef } from "react";
import type { StorageReconciliationSummary } from "../../types/ops";

interface StorageReconciliationSectionProps {
  loading?: boolean;
  error?: string;
  summary?: StorageReconciliationSummary;
  summaries?: StorageReconciliationSummary[];
  onRetry?: () => void;
}

function bytes(value?: number | null) {
  if (value === undefined || value === null || !Number.isFinite(value)) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

export function StorageReconciliationSection({ loading = false, error, summary, summaries = [], onRetry }: StorageReconciliationSectionProps) {
  const errorRef = useRef<HTMLDivElement>(null);
  const errorTitleId = useId();
  const errorDescriptionId = useId();
  useEffect(() => {
    if (error) errorRef.current?.focus({ preventScroll: true });
  }, [error]);
  const counts = summary?.counts;
  const unavailable = !loading && !error && (!summary || summary.status === "unavailable");
  const attention = summary?.status === "attention_required";
  const failed = summary?.status === "failed";
  const expired = summary?.freshness === "expired";
  const stale = summary?.freshness === "stale";
  const freshnessLabel = !summary?.lastRunAt ? "新鲜度未知" : expired ? "已过期" : stale ? "已变旧" : "最近已更新";
  const statusLabel = loading ? "加载中" : error ? "加载失败" : unavailable ? "未接入对账" : failed ? "对账失败" : expired ? "对账已过期" : stale ? "需要刷新" : attention ? "需要处理" : "对账正常";
  const statusColor = loading || error || unavailable ? "default" : failed || expired || stale || attention ? "orange" : "green";
  const workspaceRows = summaries.filter(item => item.workspaceId);
  const workspaceEmpty = !loading && !error && workspaceRows.length === 0;
  return (
    <>
    <Card title="对象存储容量与对账" extra={<Tag color={statusColor}>{statusLabel}</Tag>} aria-busy={loading}>
      {loading ? <Alert role="status" aria-live="polite" aria-atomic="true" showIcon title="正在加载对账结果" description="正在读取平台范围的脱敏容量和一致性摘要。" /> : null}
      {error ? <div ref={errorRef} tabIndex={-1} role="alert" aria-live="assertive" aria-atomic="true" aria-labelledby={errorTitleId} aria-describedby={errorDescriptionId} data-state="error" data-focus-target="error-summary">
        <Alert type="error" showIcon title={<span id={errorTitleId}>对账结果加载失败</span>} description={<span id={errorDescriptionId}>{error}</span>} action={onRetry ? <Button type="primary" icon={<ReloadOutlined aria-hidden />} aria-label="重试加载对账结果" style={{ minHeight: 44 }} onClick={onRetry}>重试</Button> : undefined} />
      </div> : null}
      {unavailable ? <Alert type="info" showIcon title="暂无可验证的对象清单对账结果" description={summary?.message ?? "该卡片只显示脱敏容量和一致性状态，不提供客户素材、对象 key 或下载入口。"} /> : null}
      {attention ? <Alert type="warning" showIcon title="发现存储一致性问题" description="请由存储负责人查看受控对账证据；此页面不展示客户对象详情。" /> : null}
      {failed ? <Alert type="error" showIcon title="最近一次对账失败" description="对账没有产出可验证结果；请检查对象清单、数据库和定时任务后重试。" /> : null}
      {expired ? <Alert type="warning" showIcon title="对账结果已过期" description="当前汇总不能代表最新对象状态；请先恢复对账任务，再据此处理容量或一致性问题。" /> : null}
      <Row gutter={[16, 16]}>
        <Col xs={12} md={6}><Statistic title="已使用" value={bytes(summary?.quota?.usedBytes)} /></Col>
        <Col xs={12} md={6}><Statistic title="配额上限" value={bytes(summary?.quota?.limitBytes)} /></Col>
        <Col xs={12} md={6}><Statistic title="预留中" value={bytes(summary?.quota?.reservedBytes)} /></Col>
        <Col xs={12} md={6}><Statistic title="预计占用" value={bytes(summary?.quota?.projectedBytes)} /></Col>
      </Row>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        最近对账：{summary?.lastRunAt ?? "暂无"} · {freshnessLabel}。仅显示 workspace 级汇总和问题数量，不暴露客户对象下载能力。
      </Typography.Paragraph>
      {counts ? <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        引用 {counts.references} · 对象 {counts.inventoryObjects} · 匹配 {counts.matched} · 缺失 {counts.missing} · 孤儿 {counts.orphans} · 元数据不一致 {counts.metadataMismatches}
      </Typography.Paragraph> : null}
    </Card>
    {workspaceRows.length ? <Card title={`workspace 对账列表（${workspaceRows.length}）`} style={{ marginTop: 16 }}>
      <div role="list" aria-label="workspace 存储对账状态">
        {workspaceRows.map(item => {
          const itemExpired = item.freshness === "expired";
          const itemFailed = item.status === "failed";
          const itemStale = item.freshness === "stale";
          const itemAttention = item.status === "attention_required" || itemExpired || itemStale;
          const itemUnavailable = item.status === "unavailable";
          return <div role="listitem" key={item.workspaceId} style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 8, padding: "10px 0", borderBottom: "1px solid #f0f0f0" }}>
            <div style={{ minWidth: 0, overflowWrap: "anywhere" }}><Typography.Text strong>{item.workspaceId}</Typography.Text><br /><Typography.Text type="secondary">最近对账：{item.lastRunAt ?? "暂无"}</Typography.Text></div>
            <Tag color={itemUnavailable ? "default" : itemFailed || itemAttention ? "orange" : "green"}>{itemUnavailable ? "未接入" : itemFailed ? "失败" : itemExpired ? "已过期" : itemStale ? "需刷新" : item.status === "attention_required" ? "需处理" : "正常"}</Tag>
          </div>;
        })}
      </div>
      <Typography.Paragraph type="secondary" style={{ margin: "12px 0 0" }}>列表仅用于定位 workspace 状态，不提供客户对象、素材内容、对象 key 或下载操作。</Typography.Paragraph>
    </Card> : workspaceEmpty ? <Card title="workspace 对账列表（0）" style={{ marginTop: 16 }}>
      <Alert
        type="info"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-state="empty"
        showIcon
        title="暂无 workspace 级对账结果"
        description="当前还没有可展示的 workspace 对账摘要；请先运行对账任务，或刷新以读取最新受控结果。"
        action={onRetry ? <Button icon={<ReloadOutlined aria-hidden />} aria-label="刷新 workspace 对账列表" style={{ minHeight: 44 }} onClick={onRetry}>刷新列表</Button> : undefined}
      />
    </Card> : null}
    </>
  );
}
