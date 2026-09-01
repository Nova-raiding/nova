import { Alert, Button, Card, Form, Input, Modal, Result, Select, Space } from 'antd'
import { useState } from 'react'
import { IncidentDetailDrawer } from '../components/incidents/IncidentDetailDrawer'
import { incidentSeverityOptions, incidentStatusOptions } from '../components/incidents/IncidentBadges'
import { IncidentsTable } from '../components/incidents/IncidentsTable'
import { OpsPage } from '../components/OpsPage'
import { useIncidents, type IncidentFilters, type IncidentSeverity, type IncidentsClient } from '../hooks/useIncidents'
import type { AuthorizationProjection } from '../authz/authorization.js'
import { useUnsavedChanges } from '../components/authz/UnsavedChangesContext.js'

type CreateValues = { title: string; summary: string; severity: IncidentSeverity; commanderId?: string; affectedComponents?: string; affectedWorkspaceIds?: string }
const list = (value?: string) => [...new Set((value ?? '').split(',').map((item) => item.trim()).filter(Boolean))]
const mutationKey = (operation: string) => `incident:${operation}:${crypto.randomUUID()}`

export function IncidentsPage({ client, authorization }: { client: IncidentsClient; authorization: AuthorizationProjection }) {
  const platformScope = authorization.scope.kind === 'platform'
  const model = useIncidents(client, {}, platformScope)
  const [draftFilters, setDraftFilters] = useState<IncidentFilters>({})
  const [createOpen, setCreateOpen] = useState(false)
  const [createDirty, setCreateDirty] = useState(false)
  const [createForm] = Form.useForm<CreateValues>()
  useUnsavedChanges(createOpen && createDirty, '事故创建表单')
  const canMutate = authorization.canAny(['incident.update', 'incident.administer'])
  const selected = model.selected
  const initialLoadFailed = Boolean(model.error && !model.loading && model.incidents.length === 0)

  return (
    <OpsPage eyebrow="INCIDENT RESPONSE" title="事故中心" description="统一管理 SEV-1 至 SEV-4 事故、指挥官、影响范围和不可变处置时间线。">
      {model.error ? <Alert role="alert" type="error" showIcon title="事故操作失败" description={model.error} action={<Button onClick={() => void model.load()}>重试</Button>} /> : null}
      <Card title="筛选与操作" extra={canMutate ? <Button type="primary" style={{ minHeight: 44 }} onClick={() => setCreateOpen(true)}>创建事故</Button> : undefined}>
        <Space wrap>
          <Select allowClear aria-label="按状态筛选" placeholder="状态" style={{ width: 180 }} value={draftFilters.status} options={incidentStatusOptions} onChange={(status) => setDraftFilters((current) => ({ ...current, status }))} />
          <Select allowClear aria-label="按严重度筛选" placeholder="严重度" style={{ width: 180 }} value={draftFilters.severity} options={incidentSeverityOptions} onChange={(severity) => setDraftFilters((current) => ({ ...current, severity }))} />
          <Button style={{ minHeight: 44 }} onClick={() => void model.load({ filters: draftFilters })}>应用筛选</Button>
          <Button style={{ minHeight: 44 }} onClick={() => { setDraftFilters({}); void model.load({ filters: {} }) }}>清除筛选</Button>
        </Space>
      </Card>

      <Card title={platformScope ? "平台事故列表" : "事故列表"} aria-busy={model.loading}>
        {initialLoadFailed ? (
          <Result status="error" title="事故列表不可用" subTitle="请修复工作区配置后重试；当前空列表不代表没有事故。" extra={<Button onClick={() => void model.load()}>重试事故列表</Button>} />
        ) : !model.loading && model.incidents.length === 0 ? (
          <Result status="info" title="暂无事故" subTitle="当前范围没有事故记录。事故发生后可在此建立指挥、状态和时间线。" extra={canMutate ? <Button type="primary" onClick={() => setCreateOpen(true)}>创建第一起事故</Button> : undefined} />
        ) : <IncidentsTable incidents={model.incidents} loading={model.loading} onSelect={(incident) => void model.select(incident)} />}
        {model.nextCursor ? <Button block style={{ minHeight: 44, marginTop: 16 }} loading={model.loading} onClick={() => void model.load({ append: true })}>加载更多事故</Button> : null}
      </Card>

      <IncidentDetailDrawer
        incident={selected}
        timeline={model.timeline}
        timelineNextCursor={model.timelineNextCursor}
        loading={model.detailLoading}
        mutating={model.mutating}
        error={model.error}
        canMutate={canMutate}
        onClose={model.close}
        onLoadMoreTimeline={model.loadMoreTimeline}
        onComment={async (body) => { if (selected) await model.comment({ incidentId: selected.id, expectedRevision: selected.revision, body, idempotencyKey: mutationKey('comment') }) }}
        onTransition={async (note) => { if (selected) { const toStatus = ({ investigating: 'identified', identified: 'monitoring', monitoring: 'resolved', resolved: undefined } as const)[selected.status]; if (toStatus) await model.transition({ incidentId: selected.id, expectedRevision: selected.revision, toStatus, note, idempotencyKey: mutationKey('transition') }) } }}
        onAssignCommander={async (commanderId, note) => { if (selected) await model.assignCommander({ incidentId: selected.id, expectedRevision: selected.revision, ...(commanderId ? { commanderId } : {}), note, idempotencyKey: mutationKey('commander') }) }}
        onUpdateScope={async (affectedComponents, affectedWorkspaceIds, note) => { if (selected) await model.updateScope({ incidentId: selected.id, expectedRevision: selected.revision, affectedComponents, affectedWorkspaceIds, note, idempotencyKey: mutationKey('scope') }) }}
      />

      <Modal title="创建事故" open={createOpen} confirmLoading={model.mutating} onCancel={() => { setCreateDirty(false); createForm.resetFields(); setCreateOpen(false) }} onOk={() => createForm.submit()} okText="创建事故" cancelText="取消" destroyOnHidden>
        <Form<CreateValues> form={createForm} layout="vertical" onValuesChange={() => setCreateDirty(true)} onFinish={async (values) => {
          try {
            await model.create({ title: values.title.trim(), summary: values.summary.trim(), severity: values.severity, ...(values.commanderId?.trim() ? { commanderId: values.commanderId.trim() } : {}), affectedComponents: list(values.affectedComponents), affectedWorkspaceIds: list(values.affectedWorkspaceIds), idempotencyKey: mutationKey('create') })
            createForm.resetFields(); setCreateDirty(false); setCreateOpen(false)
          } catch { /* Keep the dialog open; the page alert explains the failure. */ }
        }}>
          <Form.Item name="title" label="事故标题" rules={[{ required: true, min: 3, max: 160, message: '请输入 3–160 个字符的事故标题' }]}><Input autoFocus maxLength={160} /></Form.Item>
          <Form.Item name="summary" label="影响摘要" rules={[{ required: true, min: 3, max: 4000, message: '请输入 3–4000 个字符的影响摘要' }]}><Input.TextArea rows={4} maxLength={4000} showCount /></Form.Item>
          <Form.Item name="severity" label="严重度" rules={[{ required: true, message: '请选择严重度' }]}><Select options={incidentSeverityOptions} /></Form.Item>
          <Form.Item name="commanderId" label="指挥官 ID"><Input maxLength={160} /></Form.Item>
          <Form.Item name="affectedComponents" label="受影响组件（逗号分隔）"><Input placeholder="api, worker, payment" /></Form.Item>
          <Form.Item name="affectedWorkspaceIds" label="受影响工作区（逗号分隔）"><Input placeholder="ws_123, ws_456" /></Form.Item>
        </Form>
      </Modal>
    </OpsPage>
  )
}
