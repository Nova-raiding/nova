import { Alert, Button, Descriptions, Divider, Drawer, Form, Grid, Input, Space, Spin, Timeline, Typography } from 'antd'
import { useEffect, useRef, useState } from 'react'
import { incidentNextStatus, type IncidentTimelineEntry, type OpsIncident } from '../../hooks/useIncidents'
import { IncidentSeverityBadge, IncidentStatusBadge } from './IncidentBadges'

const splitList = (value: string) => [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))]

interface IncidentDetailDrawerProps {
  incident?: OpsIncident
  timeline: IncidentTimelineEntry[]
  timelineNextCursor?: string
  loading: boolean
  mutating: boolean
  error?: string
  canMutate: boolean
  onClose: () => void
  onLoadMoreTimeline: () => Promise<unknown>
  onComment: (body: string) => Promise<unknown>
  onTransition: (note: string) => Promise<unknown>
  onAssignCommander: (commanderId: string | undefined, note: string) => Promise<unknown>
  onUpdateScope: (components: string[], workspaceIds: string[], note: string) => Promise<unknown>
}

export function incidentDetailCapabilities(canMutate: boolean) {
  return { canRead: true, canComment: true, canTransition: canMutate, canAssignCommander: canMutate, canUpdateScope: canMutate }
}

export function IncidentDetailDrawer(props: IncidentDetailDrawerProps) {
  const { incident } = props
  const screens = Grid.useBreakpoint()
  const [comment, setComment] = useState('')
  const [transitionNote, setTransitionNote] = useState('')
  const [commanderId, setCommanderId] = useState('')
  const [commanderNote, setCommanderNote] = useState('')
  const [components, setComponents] = useState('')
  const [workspaces, setWorkspaces] = useState('')
  const [scopeNote, setScopeNote] = useState('')
  const errorRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (incident) triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }, [incident?.id])
  useEffect(() => {
    if (props.error) window.requestAnimationFrame(() => errorRef.current?.focus({ preventScroll: true }))
  }, [props.error])
  useEffect(() => {
    setCommanderId(incident?.commanderId ?? '')
    setComponents(incident?.affectedComponents.join(', ') ?? '')
    setWorkspaces(incident?.affectedWorkspaceIds.join(', ') ?? '')
  }, [incident?.id])
  if (!incident) return null
  const capabilities = incidentDetailCapabilities(props.canMutate)
  const nextStatus = incidentNextStatus[incident.status]
  const settle = async (operation: () => Promise<unknown>, clear: () => void) => {
    try { await operation(); clear() } catch { /* The page-level role=alert owns error presentation. */ }
  }

  return (
    <Drawer open title={`事故详情 · ${incident.title}`} size={720} onClose={props.onClose} destroyOnHidden aria-label="事故详情" afterOpenChange={(open) => {
      if (!open && triggerRef.current?.isConnected) window.requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }))
    }}>
      <section aria-label="事故详情内容" aria-busy={props.loading}>
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {props.loading ? '正在加载事故详情，已有内容会保留。' : '事故详情已加载。'}
        </div>
        <Spin spinning={props.loading}>
        {props.error ? <div ref={errorRef} tabIndex={-1} aria-label="事故详情错误摘要"><Alert role="alert" aria-live="assertive" aria-atomic="true" type="error" showIcon title="事故操作失败" description={props.error} style={{ marginBottom: 16 }} /></div> : null}
        <Descriptions bordered size="small" column={screens.md ? 2 : 1}>
          <Descriptions.Item label="严重度"><IncidentSeverityBadge severity={incident.severity} /></Descriptions.Item>
          <Descriptions.Item label="状态"><IncidentStatusBadge status={incident.status} /></Descriptions.Item>
          <Descriptions.Item label="指挥官">{incident.commanderId || '待指派'}</Descriptions.Item>
          <Descriptions.Item label="Revision">{incident.revision}</Descriptions.Item>
          <Descriptions.Item label="受影响组件" span={screens.md ? 2 : 1}>{incident.affectedComponents.join('、') || '未记录'}</Descriptions.Item>
          <Descriptions.Item label="受影响工作区" span={screens.md ? 2 : 1}>{incident.affectedWorkspaceIds.join('、') || '未记录'}</Descriptions.Item>
          <Descriptions.Item label="摘要" span={screens.md ? 2 : 1}>{incident.summary}</Descriptions.Item>
        </Descriptions>

        <Divider>不可变时间线</Divider>
        {props.timeline.length ? (
          <div aria-live="polite"><Timeline items={props.timeline.map((entry) => ({ content: <div><Typography.Text strong>{entry.kind}</Typography.Text><Typography.Paragraph style={{ marginBottom: 2 }}>{entry.body}</Typography.Paragraph><Typography.Text type="secondary">{entry.actorId} · revision {entry.incidentRevision} · {new Date(entry.createdAt).toLocaleString()}</Typography.Text></div> }))} /></div>
        ) : <Typography.Paragraph type="secondary">暂无时间线记录。</Typography.Paragraph>}
        {props.timelineNextCursor ? <Button block loading={props.loading} onClick={() => void props.onLoadMoreTimeline()} style={{ minHeight: 44, marginBottom: 16 }}>加载更多时间线</Button> : null}

        <Divider>追加评论</Divider>
        <Form layout="vertical" onFinish={() => settle(() => props.onComment(comment), () => setComment(''))}>
          <Form.Item label="评论" required validateStatus={!comment.trim() ? undefined : 'success'}>
            <Input.TextArea value={comment} onChange={(event) => setComment(event.target.value)} maxLength={4000} showCount rows={3} aria-label="事故评论" />
          </Form.Item>
          <Button htmlType="submit" type="primary" loading={props.mutating} disabled={!comment.trim()} style={{ minHeight: 44 }}>追加评论</Button>
        </Form>

        {capabilities.canTransition ? <>
          <Divider>平台运营操作</Divider>
          {nextStatus ? <Form layout="vertical" onFinish={() => settle(() => props.onTransition(transitionNote), () => setTransitionNote(''))}>
            <Form.Item label={`推进至 ${nextStatus}`} required>
              <Input.TextArea value={transitionNote} onChange={(event) => setTransitionNote(event.target.value)} maxLength={4000} rows={2} aria-label="状态推进说明" />
            </Form.Item>
            <Button htmlType="submit" loading={props.mutating} disabled={transitionNote.trim().length < 3} style={{ minHeight: 44 }}>确认推进状态</Button>
          </Form> : <Alert type="success" showIcon title="事故已解决" description="已解决事故保持终态；如发生新影响，请创建新事故以保留历史边界。" />}

          <Form layout="vertical" style={{ marginTop: 20 }} onFinish={() => settle(() => props.onAssignCommander(commanderId.trim() || undefined, commanderNote), () => setCommanderNote(''))}>
            <Space wrap align="start">
              <Form.Item label="指挥官 ID"><Input value={commanderId} onChange={(event) => setCommanderId(event.target.value)} maxLength={160} placeholder="留空表示解除指派" /></Form.Item>
              <Form.Item label="变更原因" required><Input value={commanderNote} onChange={(event) => setCommanderNote(event.target.value)} maxLength={4000} /></Form.Item>
              <Form.Item label=" "><Button htmlType="submit" loading={props.mutating} disabled={commanderNote.trim().length < 3} style={{ minHeight: 44 }}>更新指挥官</Button></Form.Item>
            </Space>
          </Form>

          <Form layout="vertical" style={{ marginTop: 8 }} onFinish={() => settle(() => props.onUpdateScope(splitList(components), splitList(workspaces), scopeNote), () => setScopeNote(''))}>
            <Form.Item label="受影响组件（逗号分隔）"><Input value={components} onChange={(event) => setComponents(event.target.value)} placeholder={incident.affectedComponents.join(', ')} /></Form.Item>
            <Form.Item label="受影响工作区（逗号分隔）"><Input value={workspaces} onChange={(event) => setWorkspaces(event.target.value)} placeholder={incident.affectedWorkspaceIds.join(', ')} /></Form.Item>
            <Form.Item label="范围变更原因" required><Input.TextArea value={scopeNote} onChange={(event) => setScopeNote(event.target.value)} rows={2} maxLength={4000} /></Form.Item>
            <Button htmlType="submit" loading={props.mutating} disabled={scopeNote.trim().length < 3} style={{ minHeight: 44 }}>更新影响范围</Button>
          </Form>
        </> : <Alert style={{ marginTop: 20 }} type="info" showIcon title="当前范围只读" description="缺少 incident.update / incident.administer；状态、指挥官和影响范围不可修改。" />}
        </Spin>
      </section>
    </Drawer>
  )
}
