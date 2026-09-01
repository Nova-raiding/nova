import { CustomerServiceOutlined, GlobalOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Empty, Space, Statistic, Tag, Typography } from "antd";
import { useEffect, useRef } from "react";
import type { StoreDirectory } from "../../types/ops";

export type PlatformSummary = {
  platform: string;
  storeCount: number;
  officialApiCount: number;
  attentionCount: number;
};

export function summarizePlatforms(stores: StoreDirectory[]): PlatformSummary[] {
  const summaries = new Map<string, PlatformSummary>();
  for (const store of stores) {
    const current = summaries.get(store.platform) ?? { platform: store.platform, storeCount: 0, officialApiCount: 0, attentionCount: 0 };
    current.storeCount += 1;
    if (store.dataMode === "official_api") current.officialApiCount += 1;
    if (store.state !== "connected" || store.authorization?.reauthorizationRequired) current.attentionCount += 1;
    summaries.set(store.platform, current);
  }
  return [...summaries.values()].sort((left, right) => left.platform.localeCompare(right.platform));
}

interface PlatformSummarySectionProps {
  stores: StoreDirectory[];
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  onOpenSupport: () => void;
  platformLabels: Record<string, string>;
}

export function PlatformSummarySection({ stores, loading = false, error, onRetry, onOpenSupport, platformLabels }: PlatformSummarySectionProps) {
  const summaries = summarizePlatforms(stores);
  const errorRef = useRef<HTMLDivElement>(null);
  const previousError = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (error && !previousError.current) errorRef.current?.focus();
    previousError.current = error;
  }, [error]);

  return (
    <Card
      title={<Space><GlobalOutlined aria-hidden="true" />平台连接汇总</Space>}
      extra={<Button htmlType="button" type="primary" icon={<CustomerServiceOutlined aria-hidden="true" />} onClick={onOpenSupport} style={{ minHeight: 44 }}>受控支持入口</Button>}
    >
      <Typography.Paragraph type="secondary">
        平台运营只查看连接健康与汇总指标；客户店铺、商品和素材详情仅通过客服工单按授权范围受控处理。
      </Typography.Paragraph>
      <div aria-busy={loading || undefined}>
        {loading && <div role="status" aria-live="polite" aria-label="正在更新平台连接汇总" style={{ marginBottom: 12 }}>正在更新平台连接汇总；上次可信数据仍保留。</div>}
        {error && <div ref={errorRef} tabIndex={-1} aria-label="平台汇总错误摘要">
          <Alert role="alert" aria-live="assertive" aria-atomic="true" type="error" showIcon title="平台汇总读取失败" description={error} action={onRetry ? <Button htmlType="button" style={{ minHeight: 44 }} aria-label="重试平台汇总" onClick={onRetry}>重试</Button> : undefined} />
        </div>}
        {summaries.length > 0 ? <div className="platform-summary-grid" aria-label={loading || error ? "上次可信的平台连接汇总" : "平台连接汇总"}>{summaries.map(summary => <Card size="small" key={summary.platform} title={platformLabels[summary.platform] ?? summary.platform}><Space wrap><Statistic title="登记店铺" value={summary.storeCount} /><Statistic title="官方 API" value={summary.officialApiCount} /><Tag color={summary.attentionCount ? "orange" : "green"}>{summary.attentionCount ? `${summary.attentionCount} 个需关注` : "连接正常"}</Tag></Space></Card>)}</div> : !loading && !error ? <Empty description="暂无平台连接汇总" /> : null}
      </div>
    </Card>
  );
}
