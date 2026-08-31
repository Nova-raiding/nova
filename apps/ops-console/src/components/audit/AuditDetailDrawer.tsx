import { Alert, Button, Descriptions, Drawer, Empty, Skeleton, Tag, Typography } from 'antd'
import type { AuditCenterDetail, AuditCenterRecord } from '../../../../../packages/contracts/src/ops/audit-center.js'

interface Props {
  selected?: AuditCenterRecord
  detail?: AuditCenterDetail
  loading: boolean
  error?: string
  onRetry?: () => void
  onClose(): void
}

const evidenceValue = (value: string | number | boolean | null) => value === null ? 'null' : String(value)

export function AuditDetailDrawer({ selected, detail, loading, error, onRetry, onClose }: Props) {
  return <Drawer
    open={Boolean(selected)}
    title="审计证据详情（已脱敏）"
    size="min(640px, calc(100vw - 16px))"
    onClose={onClose}
    destroyOnHidden
    keyboard
    autoFocus
    aria-label="审计证据详情"
    styles={{ body: { overflowWrap: 'anywhere' } }}
  >
    {error ? <Alert role="alert" type="error" showIcon title="详情加载失败" description={error}
      action={onRetry ? <Button onClick={onRetry} style={{ minHeight: 44 }}>重试</Button> : undefined} /> : null}
    {loading ? <Skeleton active aria-label="正在加载审计详情" /> : detail ? <>
      <Tag color="blue" style={{ marginBottom: 16 }}>服务端已脱敏</Tag>
      <Descriptions bordered size="small" column={1}>
        <Descriptions.Item label="来源"><Tag>{detail.source}</Tag></Descriptions.Item>
        <Descriptions.Item label="事件 ID"><Typography.Text copyable style={{ overflowWrap: 'anywhere' }}>{detail.id}</Typography.Text></Descriptions.Item>
        <Descriptions.Item label="操作者"><span style={{ overflowWrap: 'anywhere' }}>{detail.actorId}</span></Descriptions.Item>
        <Descriptions.Item label="动作"><span style={{ overflowWrap: 'anywhere' }}>{detail.action}</span></Descriptions.Item>
        <Descriptions.Item label="资源"><span style={{ overflowWrap: 'anywhere' }}>{detail.resourceType} / {detail.resourceId}</span></Descriptions.Item>
        <Descriptions.Item label="原因">{detail.reason || '未提供'}</Descriptions.Item>
        <Descriptions.Item label="时间">{new Date(detail.occurredAt).toLocaleString()}</Descriptions.Item>
      </Descriptions>
      <Typography.Title level={5} style={{ marginTop: 24 }}>脱敏证据字段</Typography.Title>
      {Object.keys(detail.evidence.fields).length ? <Descriptions bordered size="small" column={1}>
        {Object.entries(detail.evidence.fields).map(([key, value]) => <Descriptions.Item key={key} label={key}>
          <Typography.Text code style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{evidenceValue(value)}</Typography.Text>
        </Descriptions.Item>)}
      </Descriptions> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该事件没有可展示的安全证据字段" />}
      <Typography.Paragraph type="secondary" role="status" style={{ marginTop: 16 }}>
        已省略 {detail.evidence.omittedFields} 个敏感、过深或不受支持的字段。原始密钥、令牌、支付链接和错误元数据不会下发到前端。
      </Typography.Paragraph>
    </> : null}
  </Drawer>
}
