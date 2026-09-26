import { useMemo, useState } from "react";
import { Alert, Button, Card, Descriptions, Empty, Select, Space, Table, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { Rule } from "../../types/ops.js";
import { rpc } from "../../api/opsClient.js";

export type RuleAuditEvent = {
  id: string;
  workspaceId: string;
  rulePackId: string;
  ruleVersionId: string;
  version: string;
  action: string;
  actorId: string;
  reason?: string | null;
  occurredAt: string;
  data: Record<string, unknown>;
};

export function buildRulePackOptions(rules: readonly Rule[]) {
  const names = new Map<string, string>();
  for (const rule of rules) if (!names.has(rule.packId)) names.set(rule.packId, rule.name);
  return [
    { value: "", label: "全部规则包" },
    ...[...names].sort(([left], [right]) => left.localeCompare(right)).map(([id, name]) => ({ value: id, label: `${name} · ${id}` })),
  ];
}

export function parseRuleAuditEvents(value: unknown): RuleAuditEvent[] {
  if (!Array.isArray(value) || !value.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const event = item as Record<string, unknown>;
    return ["id", "workspaceId", "rulePackId", "ruleVersionId", "version", "action", "actorId", "occurredAt"]
      .every((key) => typeof event[key] === "string" && event[key].trim().length > 0)
      && (event.reason === undefined || event.reason === null || typeof event.reason === "string")
      && Number.isFinite(Date.parse(String(event.occurredAt)))
      && Boolean(event.data && typeof event.data === "object" && !Array.isArray(event.data));
  })) throw new Error("规则审计服务返回了无法识别的事件记录，请刷新后重试");
  return [...value as RuleAuditEvent[]].sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt)
    || right.id.localeCompare(left.id));
}

const actionLabels: Record<string, string> = {
  created: "创建草稿",
  activated: "启用版本",
  deactivated: "停用版本",
  expired: "版本过期",
};

const columns: ColumnsType<RuleAuditEvent> = [
  { title: "时间", dataIndex: "occurredAt", width: 190, render: (value: string) => new Date(value).toLocaleString() },
  { title: "规则包", dataIndex: "rulePackId", width: 220, render: (value: string) => <Typography.Text code copyable>{value}</Typography.Text> },
  { title: "版本", dataIndex: "version", width: 130 },
  { title: "事件", dataIndex: "action", width: 130, render: (value: string) => actionLabels[value] ?? value },
  { title: "操作者", dataIndex: "actorId", width: 180 },
  { title: "操作原因", dataIndex: "reason", render: (value?: string | null) => value?.trim() || "未记录原因" },
];

export function WorkspaceRuleAuditPanel({ rules, canRead, workspaceId }: {
  rules: readonly Rule[];
  canRead: boolean;
  workspaceId?: string;
}) {
  const [packId, setPackId] = useState("");
  const [events, setEvents] = useState<RuleAuditEvent[]>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const packOptions = useMemo(() => buildRulePackOptions(rules), [rules]);

  if (!canRead) return null;

  const run = async () => {
    if (loading) return;
    setLoading(true);
    setError("");
    setEvents(undefined);
    try {
      const result = await rpc<unknown>("ops.rules.workspace.audit", packId ? { pack_id: packId } : {});
      setEvents(parseRuleAuditEvents(result));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "规则审计读取失败");
    } finally {
      setLoading(false);
    }
  };

  return <Card size="small" title="工作区规则审计" extra={<Typography.Text type="secondary">只读事件 · 最新记录优先</Typography.Text>}>
    <Space wrap style={{ width: "100%", marginBottom: 12 }}>
      <Typography.Text type="secondary">{workspaceId ? `审计范围：${workspaceId}` : "审计范围：当前工作区"}</Typography.Text>
      <Select aria-label="按规则包筛选审计记录" value={packId} options={packOptions} onChange={value => { setPackId(value); setEvents(undefined); }} style={{ minWidth: 300 }} />
      <Button type="primary" loading={loading} onClick={() => void run()}>读取审计记录</Button>
    </Space>
    {error && <Alert type="error" showIcon title="规则审计读取失败" description={error} style={{ marginBottom: 12 }} />}
    {events !== undefined ? events.length ? <Table
      rowKey="id"
      size="small"
      dataSource={events}
      columns={columns}
      pagination={{ pageSize: 10, showSizeChanger: false, showTotal: total => `共 ${total} 条` }}
      scroll={{ x: 1050 }}
      expandable={{ expandedRowRender: event => <Descriptions size="small" column={1} items={[
        { key: "version-id", label: "规则版本 ID", children: <Typography.Text code copyable>{event.ruleVersionId}</Typography.Text> },
        { key: "evidence", label: "审批与来源证据", children: Object.keys(event.data).length
          ? <Typography.Paragraph copyable={{ text: JSON.stringify(event.data, null, 2) }} style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>{JSON.stringify(event.data, null, 2)}</Typography.Paragraph>
          : "无附加证据" },
      ]} /> }}
    /> : <Empty description="当前筛选范围内没有规则审计事件" /> : <Typography.Text type="secondary">选择规则包后读取变更记录；也可查看全部规则包。</Typography.Text>}
  </Card>;
}
