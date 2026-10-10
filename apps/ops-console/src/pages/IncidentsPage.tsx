import { Alert, Button, Card, Form, Input, Modal, Result, Select, Space } from 'antd'
import { useEffect, useRef, useState } from 'react'
import { IncidentDetailDrawer } from '../components/incidents/IncidentDetailDrawer'
import { incidentSeverityOptions, incidentStatusOptions } from '../components/incidents/IncidentBadges'
import { IncidentsTable } from '../components/incidents/IncidentsTable'
import { OpsPage } from '../components/OpsPage'
import { incidentErrorTargetsSelection, useIncidents, type IncidentFilters, type IncidentSeverity, type IncidentsClient } from '../hooks/useIncidents'
import type { AuthorizationProjection } from '../authz/authorization.js'
import { useUnsavedChanges } from '../components/authz/UnsavedChangesContext.js'

type CreateValues = { title: string; summary: string; severity: IncidentSeverity; commanderId?: string; affectedComponents?: string; affectedWorkspaceIds?: string }
const list = (value?: string) => [...new Set((value ?? '').split(',').map((item) => item.trim()).filter(Boolean))]
const mutationKey = (operation: string) => `incident:${operation}:${crypto.randomUUID()}`

function IncidentsWorkspace({ client, authorization }: { client: IncidentsClient; authorization: AuthorizationProjection }) {
  const platformScope = authorization.scope.kind === 'platform'
  const recoveryScopeKey = `${authorization.actorId ?? 'unknown-actor'}:${authorization.scope.kind}:${authorization.scope.id ?? 'unknown'}`
  const model = useIncidents(client, {}, platformScope, recoveryScopeKey)
  const [draftFilters, setDraftFilters] = useState<IncidentFilters>({})
  const [createOpen, setCreateOpen] = useState(false)
  const [createDirty, setCreateDirty] = useState(false)
  const retryRef = useRef<HTMLDivElement>(null)
  const [createForm] = Form.useForm<CreateValues>()
  useUnsavedChanges(createOpen && createDirty, '事故创建表单')
  const canMutate = authorization.canAny(['incident.update', 'incident.administer'])
  const selected = model.selected
  const initialLoadFailed = Boolean(model.errorContext === 'list-read' && model.error && !model.loading && model.incidents.length === 0)
  const failedMutationIsSelected = incidentErrorTargetsSelection(model.errorIncidentId, selected?.id)
  const failedMutationTarget = model.errorIncidentId
    ? model.incidents.find((incident) => incident.id === model.errorIncidentId) ?? model.uncertainMutationTarget
    : model.uncertainMutationTarget
  const errorRecovery = model.errorContext === 'detail-mutation' && failedMutationIsSelected
    ? { label: '重新核对所选事故', action: () => model.retryDetail() }
    : model.errorContext === 'detail-mutation' && failedMutationTarget
      ? { label: `重新核对失败目标：${failedMutationTarget.title}`, action: () => model.select(failedMutationTarget) }
    : model.errorContext === 'create-mutation' || model.errorContext === 'detail-mutation'
      ? { label: '重新读取事故列表', action: () => model.load() }
      : model.errorContext === 'append-read'
        ? { label: '重试加载更多事故', action: () => model.load({ append: true }) }
        : { label: '重试', action: () => model.load() }
  const errorDescription = model.recoveryWriteBlocked
    ? `${model.error}本次写请求未发送，解决浏览器存储问题后可安全重试。`
    : model.errorContext === 'detail-mutation' && failedMutationIsSelected
    ? `${model.error}。操作结果尚未确认，系统不会自动重放；请重新读取所选事故后核对状态。`
    : model.errorContext === 'create-mutation'
      ? `${model.error}。创建结果尚未确认，系统不会自动重放；请重新读取事故列表后再决定是否创建。`
      : model.errorContext === 'detail-mutation'
        ? `${model.error}。事故操作结果尚未确认，系统不会自动重放；请核对失败操作对应的事故${failedMutationTarget ? `“${failedMutationTarget.title}”（${failedMutationTarget.id}）` : `（${model.errorIncidentId ?? '目标 ID 未记录'}）`}。完成核对前，所有事故写操作（包括创建）保持锁定。`
      : model.errorContext === 'append-read'
        ? `${model.error}。现有事故列表已保留，可沿用当前分页位置重试。`
      : model.error
  const errorTitle = model.errorContext === 'list-read' || model.errorContext === 'append-read' ? '事故列表读取失败' : '事故操作失败'
  const showPageError = model.error && !initialLoadFailed
    && !(failedMutationIsSelected && model.errorContext === 'detail-mutation')
    && !(createOpen && (model.errorContext === 'create-mutation' || model.errorContext === 'list-read'))
  useEffect(() => {
    if (initialLoadFailed) retryRef.current?.focus({ preventScroll: true })
  }, [initialLoadFailed])

  return (
    <OpsPage eyebrow="INCIDENT RESPONSE" title="事故中心" description="统一管理 SEV-1 至 SEV-4 事故、指挥官、影响范围和不可变处置时间线。" actions={<Button type="primary" loading={model.loading} onClick={() => void model.load()}>刷新事故</Button>}>
      <div className="ops-incidents-page">
      {showPageError ? <div ref={retryRef} tabIndex={-1} aria-label="事故错误摘要"><Alert role="alert" aria-live="assertive" aria-atomic="true" type="error" showIcon title={errorTitle} description={errorDescription} action={<Button htmlType="button" style={{ minHeight: 44 }} onClick={() => void errorRecovery.action()}>{errorRecovery.label}</Button>} /></div> : null}
      {model.mutationUncertain && model.uncertainMutationKind !== 'detail' ? <Alert role="status" aria-live="polite" type="warning" showIcon title="事故写操作结果待核对，写操作已锁定" description={model.uncertainMutationKind === 'unknown' ? '本地恢复记录无法读取，系统保持锁定。请先检查事故列表；只有恢复记录已确认是创建操作时才可从此页面解除锁定。' : '上一次创建结果未知。请刷新事故列表并核对记录；确认完成前，系统不会再次提交创建。'} action={<Space><Button htmlType="button" onClick={() => void model.load()}>重新读取事故列表</Button>{model.uncertainMutationKind === 'create' ? <Button htmlType="button" disabled={!model.createReconciled} onClick={model.acknowledgeCreateReconciliation}>我已核对列表，解除创建锁</Button> : null}</Space>} /> : null}
      <Card title="筛选与操作" extra={canMutate ? <Button type="primary" disabled={model.mutationUncertain} title={model.mutationUncertain ? '先核对上一条事故操作结果' : undefined} style={{ minHeight: 44 }} onClick={() => setCreateOpen(true)}>创建事故</Button> : undefined}>
        <Space wrap>
          <Select allowClear aria-label="按状态筛选" placeholder="状态" style={{ width: 180 }} value={draftFilters.status} options={incidentStatusOptions} onChange={(status) => setDraftFilters((current) => ({ ...current, status }))} />
          <Select allowClear aria-label="按严重度筛选" placeholder="严重度" style={{ width: 180 }} value={draftFilters.severity} options={incidentSeverityOptions} onChange={(severity) => setDraftFilters((current) => ({ ...current, severity }))} />
          <Button style={{ minHeight: 44 }} onClick={() => void model.load({ filters: draftFilters })}>应用筛选</Button>
          <Button style={{ minHeight: 44 }} onClick={() => { setDraftFilters({}); void model.load({ filters: {} }) }}>清除筛选</Button>
        </Space>
      </Card>

      <Card title={platformScope ? "平台事故列表" : "事故列表"} aria-busy={model.loading}>
        {initialLoadFailed ? (
          <Result status="error" title="事故列表不可用" subTitle={<>{model.error}。请修复工作区配置后重试；当前空列表不代表没有事故。</>} extra={<Button htmlType="button" style={{ minHeight: 44 }} onClick={() => void model.load()}>重试事故列表</Button>} />
        ) : !model.loading && model.incidents.length === 0 ? (
          <Result status="info" title="暂无事故" subTitle="当前范围没有事故记录。事故发生后可在此建立指挥、状态和时间线。" extra={canMutate ? <Button type="primary" disabled={model.mutationUncertain} title={model.mutationUncertain ? '先核对上一条事故操作结果' : undefined} onClick={() => setCreateOpen(true)}>创建第一起事故</Button> : undefined} />
        ) : <IncidentsTable incidents={model.incidents} loading={model.loading} onSelect={(incident) => void model.select(incident)} />}
        {model.nextCursor ? <Button block style={{ minHeight: 44, marginTop: 16 }} loading={model.loading} onClick={() => void model.load({ append: true })}>加载更多事故</Button> : null}
      </Card>

      <IncidentDetailDrawer
        incident={selected}
        timeline={model.timeline}
        timelineNextCursor={model.timelineNextCursor}
        loading={model.detailLoading}
        detailVerified={model.detailVerified}
        detailError={model.detailError}
        onRetryDetail={model.retryDetail}
        timelineVerified={model.timelineVerified}
        timelineError={model.timelineError}
        onRetryTimeline={model.retryTimeline}
        mutating={model.mutating}
        error={model.errorContext === 'detail-mutation' && failedMutationIsSelected ? model.error : undefined}
        errorDescription={model.errorContext === 'detail-mutation' && failedMutationIsSelected ? errorDescription : undefined}
        errorAction={model.errorContext === 'detail-mutation' && failedMutationIsSelected ? { label: errorRecovery.label, onClick: errorRecovery.action } : undefined}
        mutationUncertain={model.mutationUncertain}
        mutationUncertainTarget={failedMutationTarget}
        canMutate={canMutate}
        onClose={model.close}
        onLoadMoreTimeline={model.loadMoreTimeline}
        onComment={async (body) => { if (selected) await model.comment({ incidentId: selected.id, expectedRevision: selected.revision, body, idempotencyKey: mutationKey('comment') }) }}
        onTransition={async (note) => { if (selected) { const toStatus = ({ investigating: 'identified', identified: 'monitoring', monitoring: 'resolved', resolved: undefined } as const)[selected.status]; if (toStatus) await model.transition({ incidentId: selected.id, expectedRevision: selected.revision, toStatus, note, idempotencyKey: mutationKey('transition') }) } }}
        onAssignCommander={async (commanderId, note) => { if (selected) await model.assignCommander({ incidentId: selected.id, expectedRevision: selected.revision, ...(commanderId ? { commanderId } : {}), note, idempotencyKey: mutationKey('commander') }) }}
        onUpdateScope={async (affectedComponents, affectedWorkspaceIds, note) => { if (selected) await model.updateScope({ incidentId: selected.id, expectedRevision: selected.revision, affectedComponents, affectedWorkspaceIds, note, idempotencyKey: mutationKey('scope') }) }}
      />

      <Modal title="创建事故" open={createOpen} confirmLoading={model.mutating} okButtonProps={{ disabled: model.mutationUncertain }} onCancel={() => { setCreateDirty(false); createForm.resetFields(); setCreateOpen(false) }} onOk={() => createForm.submit()} okText="创建事故" cancelText="取消" destroyOnHidden>
        {model.mutationUncertain ? <Alert role="status" aria-live="polite" type="warning" showIcon title="创建已暂停，先核对上一条事故操作" description={`${model.uncertainMutationKind === 'create' ? '上一次事故创建' : `事故${model.uncertainMutationTarget ? `“${model.uncertainMutationTarget.title}”（${model.uncertainMutationTarget.id}）` : `（${model.errorIncidentId ?? '目标 ID 未记录'}）`}`}的操作结果尚未核实。确认完成前，系统不会提交新的事故。`} action={model.uncertainMutationKind === 'create' ? <Space><Button htmlType="button" onClick={() => void model.load()}>重新读取事故列表</Button><Button htmlType="button" disabled={!model.createReconciled} onClick={model.acknowledgeCreateReconciliation}>我已核对列表，解除创建锁</Button></Space> : model.uncertainMutationTarget ? <Button htmlType="button" onClick={() => void model.select(model.uncertainMutationTarget!)}>重新核对失败目标</Button> : <Button htmlType="button" onClick={() => void model.load()}>重新读取事故列表</Button>} style={{ marginBottom: 16 }} /> : null}
        {model.error && (model.errorContext === 'create-mutation' || (createOpen && model.errorContext === 'list-read')) ? <Alert role="alert" aria-live="assertive" aria-atomic="true" type="error" showIcon title={errorTitle} description={errorDescription} action={<Button htmlType="button" style={{ minHeight: 44 }} onClick={() => void errorRecovery.action()}>{errorRecovery.label}</Button>} style={{ marginBottom: 16 }} /> : null}
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
      </div>
    </OpsPage>
  )
}

export function IncidentsPage(props: { client: IncidentsClient; authorization: AuthorizationProjection }) {
  const key = `${props.authorization.actorId ?? 'unknown-actor'}:${props.authorization.scope.kind}:${props.authorization.scope.id ?? 'unknown'}`
  return <IncidentsWorkspace key={key} {...props} />
}
