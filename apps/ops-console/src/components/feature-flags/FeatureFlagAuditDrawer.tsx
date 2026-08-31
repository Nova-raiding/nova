import { Alert, Button, Drawer, Empty, List, Skeleton, Tag, Typography } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FeatureFlag, FeatureFlagEvent } from "../../../../../packages/contracts/src/ops/feature-flags.js";

interface Props { flag?: FeatureFlag; loadEvents(flagId: string): Promise<FeatureFlagEvent[]>; onClose(): void }
export function FeatureFlagAuditDrawer({ flag, loadEvents, onClose }: Props) {
  const [events, setEvents] = useState<FeatureFlagEvent[]>([]); const [loading, setLoading] = useState(false); const [error, setError] = useState<string>();
  const request = useRef(0);
  const reload = useCallback(() => {
    if (!flag) return;
    const current = ++request.current;
    setLoading(true); setError(undefined); setEvents([]);
    void loadEvents(flag.id)
      .then(value => { if (current === request.current) setEvents(value); })
      .catch(cause => { if (current === request.current) setError(cause instanceof Error ? cause.message : "审计加载失败"); })
      .finally(() => { if (current === request.current) setLoading(false); });
  }, [flag, loadEvents]);
  useEffect(() => { reload(); return () => { request.current += 1; }; }, [reload]);
  return <Drawer open={Boolean(flag)} title={flag ? `${flag.key} 不可变审计` : "功能开关审计"} onClose={onClose} size={560}>
    {error && <Alert role="alert" type="error" showIcon title="审计记录加载失败" description={error} action={<Button onClick={reload}>重试</Button>} />}
    {loading ? <Skeleton active /> : events.length === 0 ? <Empty description="暂无审计事件" /> : <List dataSource={events} renderItem={event => <List.Item><List.Item.Meta title={<><Tag>{event.eventType}</Tag>Revision {event.after.revision}</>} description={<><Typography.Paragraph>{event.reason}</Typography.Paragraph><Typography.Text type="secondary">{event.actorId} · {new Date(event.createdAt).toLocaleString()}</Typography.Text></>} /></List.Item>} />}
  </Drawer>;
}
