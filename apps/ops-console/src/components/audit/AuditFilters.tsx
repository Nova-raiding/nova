import { Button, Col, Form, Input, Row, Select } from 'antd'
import { auditSources } from '../../../../../packages/contracts/src/ops/audit-center.js'
import type { AuditCenterFilters } from '../../hooks/useAuditCenter.js'

interface Props {
  value: AuditCenterFilters
  disabled?: boolean
  onChange(value: AuditCenterFilters): void
}

const sourceLabels = {
  operation: '运营操作',
  rule: '规则中心',
  incident: '事故',
  support: '客服工单',
} as const

export const toLocalDateTimeValue = (iso?: string) => {
  if (!iso) return ''
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return ''
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

export const fromLocalDateTimeValue = (value: string) =>
  value ? new Date(value).toISOString() : undefined

const controlStyle = { minHeight: 44 }

export function AuditFilters({ value, disabled, onChange }: Props) {
  const fromValue = toLocalDateTimeValue(value.fromAt)
  const toValue = toLocalDateTimeValue(value.toAt)

  return <Form layout="vertical" aria-label="审计记录筛选">
    <Row gutter={[16, 0]} align="bottom">
      <Col xs={24} md={12} xl={8}>
        <Form.Item label="关键词">
          <Input.Search allowClear maxLength={200} value={value.text} disabled={disabled}
            placeholder="操作者、动作、资源或原因"
            onChange={event => onChange({ ...value, text: event.target.value || undefined })}
            aria-label="搜索审计记录" style={controlStyle} />
        </Form.Item>
      </Col>
      <Col xs={24} md={12} xl={8}>
        <Form.Item label="来源">
          <Select mode="multiple" allowClear value={value.sources} disabled={disabled}
            options={auditSources.map(source => ({ value: source, label: sourceLabels[source] }))}
            onChange={sources => onChange({ ...value, sources: sources.length ? sources : undefined })}
            aria-label="按来源筛选" style={{ width: '100%', minHeight: 44 }} />
        </Form.Item>
      </Col>
      <Col xs={24} md={12} xl={8}>
        <Form.Item label="操作者">
          <Input allowClear maxLength={256} value={value.actorId} disabled={disabled}
            aria-label="按操作者筛选"
            onChange={event => onChange({ ...value, actorId: event.target.value || undefined })}
            style={controlStyle} />
        </Form.Item>
      </Col>
      <Col xs={24} md={12} xl={8}>
        <Form.Item label="动作">
          <Input allowClear maxLength={256} value={value.action} disabled={disabled}
            aria-label="按动作筛选"
            onChange={event => onChange({ ...value, action: event.target.value || undefined })}
            style={controlStyle} />
        </Form.Item>
      </Col>
      <Col xs={24} md={12} xl={8}>
        <Form.Item label="资源类型">
          <Input allowClear maxLength={128} value={value.resourceType} disabled={disabled}
            aria-label="按资源类型筛选"
            onChange={event => onChange({ ...value, resourceType: event.target.value || undefined })}
            style={controlStyle} />
        </Form.Item>
      </Col>
      <Col xs={24} md={12} xl={8}>
        <Form.Item label="开始时间">
          <Input type="datetime-local" value={fromValue} max={toValue || undefined} disabled={disabled}
            aria-label="审计开始时间"
            onChange={event => onChange({ ...value, fromAt: fromLocalDateTimeValue(event.target.value) })}
            style={controlStyle} />
        </Form.Item>
      </Col>
      <Col xs={24} md={12} xl={8}>
        <Form.Item label="结束时间">
          <Input type="datetime-local" value={toValue} min={fromValue || undefined} disabled={disabled}
            aria-label="审计结束时间"
            onChange={event => onChange({ ...value, toAt: fromLocalDateTimeValue(event.target.value) })}
            style={controlStyle} />
        </Form.Item>
      </Col>
      <Col xs={24} md={12} xl={8}>
        <Form.Item label="筛选操作">
          <Button block style={controlStyle} disabled={disabled} onClick={() => onChange({})}>清除筛选</Button>
        </Form.Item>
      </Col>
    </Row>
  </Form>
}
