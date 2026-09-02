import { Alert, Button, Drawer, Empty, List, Skeleton, Tag, Typography } from "antd";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { FeatureFlag, FeatureFlagEvent } from "../../../../../packages/contracts/src/ops/feature-flags.js";

interface Props { flag?: FeatureFlag; loadEvents(flagId: string): Promise<FeatureFlagEvent[]>; onClose(): void; returnFocusTo?: HTMLElement | null }
export function FeatureFlagAuditDrawer({ flag, loadEvents, onClose, returnFocusTo }: Props) {
  const [events, setEvents] = useState<FeatureFlagEvent[]>([]); const [loading, setLoading] = useState(false); const [error, setError] = useState<string>();
  const request = useRef(0);
  const errorRef = useRef<HTMLDivElement>(null);
  const errorTitleId = useId();
  const errorDescriptionId = useId();
  const loadingLabelId = useId();
  const emptyLabelId = useId();
  const reload = useCallback(() => {
    if (!flag) return;
    const current = ++request.current;
    setLoading(true); setError(undefined);
    void loadEvents(flag.id)
      .then(value => { if (current === request.current) setEvents(value); })
      .catch(cause => {
        if (current === request.current) {
          setError(cause instanceof Error ? cause.message : "审计加载失败");
          window.requestAnimationFrame(() => errorRef.current?.focus({ preventScroll: true }));
        }
      })
      .finally(() => { if (current === request.current) setLoading(false); });
  }, [flag, loadEvents]);
  useEffect(() => { reload(); return () => { request.current += 1; }; }, [reload]);
  return <Drawer open={Boolean(flag)} title={flag ? `${flag.key} 不可变审计` : "功能开关审计"} onClose={onClose} afterOpenChange={open => {
    if (!open && returnFocusTo?.isConnected) window.requestAnimationFrame(() => returnFocusTo.focus({ preventScroll: true }));
  }} size={560}>
    {error && <div
      ref={errorRef}
      tabIndex={-1}
      aria-labelledby={errorTitleId}
      aria-describedby={errorDescriptionId}
      data-focus-target="feature-flag-audit-error"
    >
      <Alert
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        type="error"
        showIcon
        message={<span id={errorTitleId}>审计记录加载失败</span>}
        description={<span id={errorDescriptionId}>{events.length > 0 ? "已保留最近一次成功加载的审计记录；修复连接后可重新拉取最新事件。" : error}</span>}
        action={<Button style={{ minHeight: 44 }} aria-label="重新加载审计记录" onClick={reload}>重试</Button>}
      />
    </div>}
    {loading ? <div role="status" aria-live="polite" aria-busy="true" aria-labelledby={loadingLabelId}>
      <Typography.Text id={loadingLabelId} type="secondary">正在加载功能开关审计记录。</Typography.Text>
      <Skeleton active paragraph={{ rows: 4 }} />
    </div> : null}
    {!loading && !error && events.length === 0 ? <div role="status" aria-live="polite" aria-labelledby={emptyLabelId}>
      <Empty description={<span id={emptyLabelId}>暂无审计事件</span>}>
        <Button style={{ minHeight: 44 }} aria-label="重新加载审计记录" onClick={reload}>重新加载</Button>
      </Empty>
    </div> : null}
    {!loading && events.length > 0 ? <List dataSource={events} renderItem={event => <List.Item><List.Item.Meta title={<><Tag>{event.eventType}</Tag>Revision {event.after.revision}</>} description={<><Typography.Paragraph>{event.reason}</Typography.Paragraph><Typography.Text type="secondary">{event.actorId} · {new Date(event.createdAt).toLocaleString()}</Typography.Text></>} /></List.Item>} /> : null}
  </Drawer>;
}
