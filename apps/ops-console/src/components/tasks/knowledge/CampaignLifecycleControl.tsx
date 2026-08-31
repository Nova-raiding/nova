import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Checkbox, Form, Input, Modal, Space, Table, Tag, Typography } from 'antd'
import { describeOpsError, rpc } from '../../../api/opsClient.js'

export type CampaignAction = 'pause' | 'resume' | 'retry_failed'
export interface CampaignControlSnapshot { id: string; state: string; revision: number; items: Array<{ id: string; productId?: string; platform?: string; accountId?: string; state: string; error?: { code?: string; message?: string } }> }

export function parseCampaignControlSnapshot(value: unknown): CampaignControlSnapshot {
  if (!value || typeof value !== 'object') throw new Error('campaign 响应格式无效')
  const row = value as Record<string, unknown>; const revision = Number(row.revision)
  if (typeof row.id !== 'string' || typeof row.state !== 'string' || !Number.isSafeInteger(revision) || revision < 1 || !Array.isArray(row.items)) throw new Error('campaign 缺少 id、state、revision 或 items')
  const items = row.items.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`campaign item ${index + 1} 格式无效`)
    const item = entry as Record<string, unknown>; const id = typeof item.id === 'string' ? item.id : typeof item.item_id === 'string' ? item.item_id : undefined
    if (!id || typeof item.state !== 'string') throw new Error(`campaign item ${index + 1} 缺少 id 或 state`)
    const field = (camel: string, snake: string) => typeof item[camel] === 'string' ? item[camel] as string : typeof item[snake] === 'string' ? item[snake] as string : undefined
    const rawError = item.error ?? item.blocker
    return { id, state: item.state, productId: field('productId', 'product_id'), platform: field('platform', 'platform'), accountId: field('accountId', 'account_id'), error: rawError && typeof rawError === 'object' ? { code: typeof (rawError as Record<string, unknown>).code === 'string' ? (rawError as Record<string, unknown>).code as string : undefined, message: typeof (rawError as Record<string, unknown>).message === 'string' ? (rawError as Record<string, unknown>).message as string : undefined } : undefined }
  })
  return { id: row.id, state: row.state, revision, items }
}

export function campaignActionParams(input: { campaign: CampaignControlSnapshot; action: CampaignAction; reason: string; itemIds?: string[]; idempotencyKey: string }) {
  const reason = input.reason.trim()
  if (reason.length < 3) throw new Error('操作原因至少填写 3 个字符')
  if (input.action === 'retry_failed' && !input.itemIds?.length) throw new Error('至少选择一个失败项')
  return { campaign_id: input.campaign.id, expected_revision: String(input.campaign.revision), idempotency_key: input.idempotencyKey, reason, ...(input.action === 'retry_failed' ? { item_ids_json: JSON.stringify(input.itemIds) } : {}) }
}

export function CampaignLifecycleControl({ canControl }: { canControl: boolean }) {
  const [campaignId, setCampaignId] = useState(''); const [campaign, setCampaign] = useState<CampaignControlSnapshot>(); const [loading, setLoading] = useState(false); const [error, setError] = useState('')
  const [action, setAction] = useState<CampaignAction>(); const [reason, setReason] = useState(''); const [confirmed, setConfirmed] = useState(false); const [selected, setSelected] = useState<string[]>([]); const [submitting, setSubmitting] = useState(false)
  const regionRef = useRef<HTMLDivElement>(null); const errorRef = useRef<HTMLDivElement>(null); const actionErrorRef = useRef<HTMLDivElement>(null)
  const failed = campaign?.items.filter(item => item.state === 'failed') ?? []
  const load = async (id = campaignId.trim()) => { if (!id) return; setLoading(true); setError(''); try { setCampaign(parseCampaignControlSnapshot(await rpc('campaign.batch.get', { campaign_id: id }))) } catch (cause) { setCampaign(undefined); setError(describeOpsError(cause)) } finally { setLoading(false) } }
  useEffect(() => { if (!loading && (campaign || error)) window.requestAnimationFrame(() => (error ? (action ? actionErrorRef.current : errorRef.current) : regionRef.current)?.focus()) }, [action, campaign, error, loading])
  const open = (next: CampaignAction) => { setAction(next); setReason(''); setConfirmed(false); setError(''); setSelected(failed.map(item => item.id)) }
  const close = () => { if (!submitting) { setAction(undefined); setReason(''); setConfirmed(false); setError('') } }
  const submit = async () => { if (!campaign || !action) return; setSubmitting(true); setError(''); try { const params = campaignActionParams({ campaign, action, reason, itemIds: selected, idempotencyKey: `ops:${action}:${campaign.id}:${crypto.randomUUID()}` }); setCampaign(parseCampaignControlSnapshot(await rpc(`campaign.batch.${action}`, params))); close() } catch (cause) { setError(describeOpsError(cause)) } finally { setSubmitting(false) } }
  return <Card className="ops-campaign-control" size="small" title="Campaign 生命周期控制" extra={<Tag color="blue">revision fail-closed</Tag>}>
    <Typography.Paragraph type="secondary">输入真实 Campaign ID 后读取服务端状态。暂停、恢复和失败项重试均提交当前 expected revision、原因和独立幂等键。</Typography.Paragraph>
    <Space.Compact block><Input aria-label="Campaign ID" value={campaignId} disabled={loading || submitting} placeholder="campaign_batch_…" onChange={event => setCampaignId(event.target.value)}/><Button type="primary" loading={loading} disabled={!campaignId.trim()} onClick={() => void load()}>读取真实状态</Button></Space.Compact>
    {!canControl && <Alert style={{ marginTop: 12 }} type="warning" showIcon title="当前会话只读" description="可读取 Campaign，但不会开放生命周期写操作。"/>}
    {error && !action && <div ref={errorRef} tabIndex={-1}><Alert style={{ marginTop: 12 }} role="alert" type="error" showIcon title="Campaign 操作失败" description={error} action={<Button onClick={() => void load()}>重试</Button>}/></div>}
    {campaign && <div ref={regionRef} tabIndex={-1} className="ops-campaign-region"><Alert type={campaign.state === 'paused' ? 'warning' : 'info'} showIcon title={`${campaign.id} · ${campaign.state}`} description={`expected revision ${campaign.revision} · ${campaign.items.length} 个独立项`}/><Space wrap style={{ margin: '12px 0' }}>
      {campaign.state === 'paused' ? <Button disabled={!canControl} onClick={() => open('resume')}>确认恢复</Button> : <Button danger disabled={!canControl} onClick={() => open('pause')}>暂停后续操作</Button>}
      <Button disabled={!canControl || !failed.length} onClick={() => open('retry_failed')}>重试失败项（{failed.length}）</Button><Button onClick={() => void load(campaign.id)} loading={loading}>刷新 revision</Button>
    </Space><Table size="small" rowKey="id" pagination={false} scroll={{ x: 680 }} dataSource={campaign.items} columns={[{ title: '平台', dataIndex: 'platform', render: value => value ?? <Typography.Text type="danger">未返回</Typography.Text> }, { title: '店铺', dataIndex: 'accountId', render: value => value ?? <Typography.Text type="danger">未返回</Typography.Text> }, { title: '商品 / Item', render: (_, item) => <><b>{item.productId ?? '商品未返回'}</b><br/><Typography.Text type="secondary">{item.id}</Typography.Text></> }, { title: '状态', dataIndex: 'state', render: value => <Tag color={value === 'failed' ? 'red' : value === 'published' ? 'green' : 'orange'}>{value}</Tag> }, { title: '错误', render: (_, item) => item.error ? `${item.error.code ?? 'FAILED'} · ${item.error.message ?? '需人工核对'}` : '—' }]}/></div>}
    <div className="ops-visually-hidden" role="status" aria-live="polite">{loading ? '正在读取 campaign' : submitting ? '正在提交 campaign 操作' : campaign ? `已读取 revision ${campaign.revision}` : error ? 'campaign 读取失败' : ''}</div>
    <Modal title={action === 'pause' ? '确认暂停 Campaign' : action === 'resume' ? '确认恢复 Campaign' : '确认重试 Campaign 失败项'} open={Boolean(action)} okText="确认并提交" cancelText="取消" confirmLoading={submitting} onCancel={close} onOk={() => void submit()} destroyOnHidden okButtonProps={{ danger: action === 'pause', disabled: submitting || reason.trim().length < 3 || !confirmed || (action === 'retry_failed' && !selected.length) }} cancelButtonProps={{ disabled: submitting }} closable={!submitting} keyboard={!submitting} mask={{ closable: !submitting }}>
      <Alert type="warning" showIcon title={`固定使用 expected revision ${campaign?.revision ?? '—'}`} description="若状态已变化，服务端会拒绝陈旧操作；暂停不会伪造取消已经进入外部平台的工作。"/>
      {action === 'retry_failed' && <Form.Item style={{ marginTop: 16 }} label="选择失败项" required><Checkbox.Group style={{ display: 'grid', gap: 8 }} value={selected} onChange={values => setSelected(values.map(String))}>{failed.map(item => <Checkbox key={item.id} value={item.id}>{item.productId ?? item.id} · {item.platform ?? '平台未返回'} · {item.accountId ?? '店铺未返回'}</Checkbox>)}</Checkbox.Group></Form.Item>}
      <Form layout="vertical" style={{ marginTop: 16 }}><Form.Item label="操作原因" required extra="至少 3 个字符；原因进入审计。"><Input.TextArea autoFocus rows={4} maxLength={1000} showCount value={reason} disabled={submitting} onChange={event => setReason(event.target.value)}/></Form.Item></Form>
      <Checkbox checked={confirmed} disabled={submitting} onChange={event => setConfirmed(event.target.checked)}>我已核对 Campaign、失败项和 expected revision，并理解外部进行中工作不会被伪造为已取消。</Checkbox>
      {error && <div ref={actionErrorRef} tabIndex={-1}><Alert style={{ marginTop: 16 }} role="alert" type="error" showIcon title="提交失败" description={error}/></div>}
    </Modal>
  </Card>
}
