import { Tag } from 'antd'
import type { IncidentSeverity, IncidentStatus } from '../../hooks/useIncidents'

const severityMeta: Record<IncidentSeverity, { label: string; color: string }> = {
  sev1: { label: 'SEV-1 严重', color: 'red' }, sev2: { label: 'SEV-2 高', color: 'volcano' },
  sev3: { label: 'SEV-3 中', color: 'gold' }, sev4: { label: 'SEV-4 低', color: 'blue' },
}
const statusMeta: Record<IncidentStatus, { label: string; color: string }> = {
  investigating: { label: '调查中', color: 'processing' }, identified: { label: '已定位', color: 'warning' },
  monitoring: { label: '观察中', color: 'cyan' }, resolved: { label: '已解决', color: 'success' },
}

export function IncidentSeverityBadge({ severity }: { severity: IncidentSeverity }) {
  const meta = severityMeta[severity]
  return <Tag color={meta.color} aria-label={`严重度：${meta.label}`}>{meta.label}</Tag>
}

export function IncidentStatusBadge({ status }: { status: IncidentStatus }) {
  const meta = statusMeta[status]
  return <Tag color={meta.color} aria-label={`状态：${meta.label}`}>{meta.label}</Tag>
}

export const incidentStatusOptions = Object.entries(statusMeta).map(([value, meta]) => ({ value: value as IncidentStatus, label: meta.label }))
export const incidentSeverityOptions = Object.entries(severityMeta).map(([value, meta]) => ({ value: value as IncidentSeverity, label: meta.label }))
