import { Button, Space, Table, Typography } from 'antd'
import type { OpsIncident } from '../../hooks/useIncidents'
import { IncidentSeverityBadge, IncidentStatusBadge } from './IncidentBadges'

export function IncidentsTable({ incidents, loading, onSelect }: { incidents: OpsIncident[]; loading: boolean; onSelect: (incident: OpsIncident) => void }) {
  return (
    <Table<OpsIncident>
      aria-label="事故列表"
      rowKey="id"
      loading={loading}
      dataSource={incidents}
      pagination={false}
      scroll={{ x: 1000 }}
      locale={{ emptyText: '当前筛选条件下没有事故记录' }}
      columns={[
        { title: '事故', dataIndex: 'title', width: 320, render: (value: string, row) => <Space orientation="vertical" size={2}><Typography.Text strong>{value}</Typography.Text><Typography.Text type="secondary">{row.id}</Typography.Text></Space> },
        { title: '严重度', dataIndex: 'severity', width: 130, render: (value: OpsIncident['severity']) => <IncidentSeverityBadge severity={value} /> },
        { title: '状态', dataIndex: 'status', width: 120, render: (value: OpsIncident['status']) => <IncidentStatusBadge status={value} /> },
        { title: '指挥官', dataIndex: 'commanderId', width: 180, render: (value?: string) => value || '待指派' },
        { title: '更新时间', dataIndex: 'updatedAt', width: 190, render: (value: string) => new Date(value).toLocaleString() },
        { title: '操作', key: 'action', fixed: 'right', width: 140, render: (_value, row) => row.aggregate ? <Typography.Text type="secondary">切换工作区查看</Typography.Text> : <Button style={{ minHeight: 44 }} onClick={() => onSelect(row)} aria-label={`查看事故：${row.title}`}>查看</Button> },
      ]}
    />
  )
}
