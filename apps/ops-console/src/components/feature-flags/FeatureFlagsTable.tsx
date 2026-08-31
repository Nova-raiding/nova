import { Button, Empty, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { FeatureFlag } from "../../../../../packages/contracts/src/ops/feature-flags.js";

interface Props { items: FeatureFlag[]; loading: boolean; canWrite: boolean; canEmergency: boolean; onEdit(flag: FeatureFlag): void; onAudit(flag: FeatureFlag): void; onEmergency(flag: FeatureFlag): void }

export function FeatureFlagsTable({ items, loading, canWrite, canEmergency, onEdit, onAudit, onEmergency }: Props) {
  const columns: ColumnsType<FeatureFlag> = [
    { title: "开关", key: "key", render: (_, row) => <Space orientation="vertical" size={0}><Typography.Text strong>{row.key}</Typography.Text><Typography.Text type="secondary">{row.description}</Typography.Text></Space> },
    { title: "环境", dataIndex: "environment", key: "environment", render: value => <Tag>{value}</Tag> },
    { title: "状态", key: "status", render: (_, row) => row.emergencyDisabled ? <Tag color="red">紧急关闭</Tag> : row.enabled ? <Tag color="green">已启用</Tag> : <Tag>默认关闭</Tag> },
    { title: "规则", key: "targets", render: (_, row) => `${row.targets.length} 条` },
    { title: "Revision", dataIndex: "revision", key: "revision" },
    { title: "更新时间", dataIndex: "updatedAt", key: "updatedAt", render: value => new Date(value).toLocaleString() },
    { title: "操作", key: "actions", render: (_, row) => <Space wrap>
      <Button aria-label={`查看 ${row.key} 审计`} style={{ minHeight: 44 }} onClick={() => onAudit(row)}>审计</Button>
      {canWrite && <Button aria-label={`编辑 ${row.key}`} style={{ minHeight: 44 }} onClick={() => onEdit(row)}>编辑</Button>}
      {canEmergency && <Button aria-label={`${row.emergencyDisabled ? "恢复" : "紧急关闭"} ${row.key}`} style={{ minHeight: 44 }} danger={!row.emergencyDisabled} onClick={() => onEmergency(row)}>{row.emergencyDisabled ? "恢复" : "紧急关闭"}</Button>}
    </Space> },
  ];
  return <Table rowKey="id" columns={columns} dataSource={items} loading={loading} pagination={false} scroll={{ x: 900 }} locale={{ emptyText: <Empty description="没有符合条件的功能开关" /> }} aria-label="功能开关列表" />;
}
