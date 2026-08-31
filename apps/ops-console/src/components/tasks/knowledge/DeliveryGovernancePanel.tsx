import { useEffect, useRef } from 'react'
import { Alert, Button, Card, Descriptions, Empty, Skeleton, Space, Tag, Typography } from 'antd'
import type { OpsConsoleModel } from '../../../hooks/useOpsConsoleModel.js'
import { useDeliveryGovernance, type DeliveryGovernanceModel } from '../../../hooks/useDeliveryGovernance.js'
import type { DeliveryEvidenceStatus, DeliveryFinding } from '../../../api/deliveryGovernanceClient.js'
import { platformLabels } from '../../../types/ops.js'

export type OpsDeliveryReadiness = 'approved' | 'expired' | 'unverified'

export function opsMediaReadiness(input: { ready?: boolean; mediaReady?: boolean; mediaEvidence?: boolean; evidenceState?: string; sourceRef?: string; schemaVersion?: string; verifiedAt?: string; expiresAt?: string }, now = Date.now()): OpsDeliveryReadiness {
  const expiry = input.expiresAt ? Date.parse(input.expiresAt) : Number.NaN
  if (Number.isFinite(expiry) && expiry <= now) return 'expired'
  return input.ready && input.mediaReady && input.mediaEvidence && input.evidenceState === 'ready' && Boolean(input.sourceRef && input.schemaVersion && input.verifiedAt) && Number.isFinite(expiry) && expiry > now ? 'approved' : 'unverified'
}

export function deliveryLiveStatus(loading: boolean, error: string | undefined, platformCount: number) {
  return loading ? '正在读取交付证据' : error ? '交付证据读取失败，缺失能力保持阻断' : `已读取 ${platformCount} 个平台的交付证据`
}

const evidenceStatusLabel: Record<DeliveryEvidenceStatus, string> = { passed: '已通过', blocked: '已阻断', unverified: '未验证' }
const evidenceStatusColor: Record<DeliveryEvidenceStatus, string> = { passed: 'green', blocked: 'red', unverified: 'orange' }

function EvidenceTag({ status }: { status: DeliveryEvidenceStatus }) {
  return <Tag color={evidenceStatusColor[status]}>{evidenceStatusLabel[status]}</Tag>
}

function Findings({ items }: { items: DeliveryFinding[] }) {
  return items.length ? <Space orientation="vertical" size="small" style={{ width: '100%' }}>{items.map((finding, index) => <Alert key={`${finding.code}:${index}`} type="warning" showIcon title={finding.code} description={<Space orientation="vertical" size={0}><span>{finding.message}</span><Typography.Text type="secondary">下一步：{finding.nextAction}</Typography.Text></Space>}/>)}</Space> : <Typography.Text type="secondary">接口未返回 finding</Typography.Text>
}

export function DeliveryReadinessCards({ state }: { state: Pick<DeliveryGovernanceModel, 'data' | 'loaded' | 'loading' | 'error'> }) {
  if (state.loading && !state.loaded) return <Card size="small" aria-busy="true"><Skeleton active paragraph={{ rows: 4 }}/></Card>
  if (state.error) return <Alert type="error" showIcon role="alert" title="交付治理 API 读取失败" description={`${state.error}。mapping、bundle 与真实性证据均保持未验证。`}/>
  if (!state.data) return <Alert type="info" showIcon title="交付治理 API 返回空响应" description="未取得 mapping preflight、bundle verification 或真实性证据；所有维度保持未验证，禁止据此进入发布。"/>
  const data = state.data
  const total = data.mappingPreflights.length + data.bundles.length + data.authenticity.length
  return <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
    <Card size="small" title="交付治理总体状态" extra={<EvidenceTag status={data.status}/>}>
      <Descriptions size="small" bordered column={{ xs: 1, sm: 2, md: 4 }} items={[
        { key: 'generated', label: '快照时间', children: data.generatedAt },
        { key: 'mapping', label: 'Mapping', children: <EvidenceTag status={data.dimensions.mapping}/> },
        { key: 'bundles', label: 'Bundles', children: <EvidenceTag status={data.dimensions.bundles}/> },
        { key: 'authenticity', label: '真实性', children: <EvidenceTag status={data.dimensions.authenticity}/> },
      ]}/>
      {!total && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="接口返回 0 条交付治理记录；三个维度保持未验证"/>}
    </Card>
    <Card size="small" title={`字段 mapping preflight（${data.mappingPreflights.length}）`}>
      {data.mappingPreflights.length ? <Space orientation="vertical" size="small" style={{ width: '100%' }}>{data.mappingPreflights.map(item => <Descriptions key={item.id} bordered size="small" column={{ xs: 1, sm: 2, md: 4 }} title={<Space><span>{platformLabels[item.platform as keyof typeof platformLabels] ?? item.platform} · {item.productId}</span><EvidenceTag status={item.status}/></Space>} items={[
        { key: 'id', label: '审批标识', children: item.id },
        { key: 'product', label: '商品', children: item.productId },
        { key: 'findings', label: 'Findings / 下一步', children: <Findings items={item.findings}/> },
      ]}/>)}</Space> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<span>API 未返回 mapping preflight 记录<br/><Typography.Text type="danger">禁止进入平台写入</Typography.Text></span>}/>}
    </Card>
    <Card size="small" title={`Delivery bundle verification（${data.bundles.length}）`}>
      {data.bundles.length ? <Space orientation="vertical" size="small" style={{ width: '100%' }}>{data.bundles.map(item => <Descriptions key={item.id} bordered size="small" column={{ xs: 1, sm: 2, md: 4 }} title={<Space><span>{item.id}</span><EvidenceTag status={item.status}/></Space>} items={[
        { key: 'task', label: '任务', children: item.taskId },
        { key: 'product', label: '商品', children: item.productId },
        { key: 'valid', label: 'Manifest', children: item.verification ? item.verification.valid ? '校验有效' : '校验失败' : '未返回' },
        { key: 'manifest', label: 'Manifest Hash', children: item.verification?.manifestHash ?? '未返回' },
        { key: 'artifact', label: 'Artifact SHA-256', children: item.verification?.artifactSha256 ?? '未返回' },
        { key: 'findings', label: 'Findings / 下一步', children: <Findings items={item.findings}/> },
      ]}/>)}</Space> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<span>API 未返回 manifest、文件哈希或 bundle verification<br/><Typography.Text type="danger">禁止标记 bundle 有效</Typography.Text></span>}/>}
    </Card>
    <Card size="small" title={`真实性证据（${data.authenticity.length}）`}>
      {data.authenticity.length ? <Space orientation="vertical" size="small" style={{ width: '100%' }}>{data.authenticity.map(item => <Descriptions key={item.id} bordered size="small" column={{ xs: 1, sm: 2, md: 4 }} title={<Space><span>{item.id}</span><EvidenceTag status={item.status}/></Space>} items={[
        { key: 'job', label: '生成任务', children: item.jobId },
        { key: 'product', label: '商品', children: item.productId },
        { key: 'findings', label: 'Findings / 下一步', children: <Findings items={item.findings}/> },
      ]}/>)}</Space> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="API 未返回图片真实性证据；人工审核或预览不能替代 attestation"/>}
    </Card>
  </Space>
}

export function DeliveryGovernancePanel({ model }: { model: OpsConsoleModel }) {
  const panelRef = useRef<HTMLDivElement>(null)
  const retryRef = useRef<HTMLButtonElement>(null)
  const restoreRetryFocus = useRef(false)
  const delivery = useDeliveryGovernance()
  const evidence = model.productionEvidence.capability
  const platformRows = Object.entries(model.platformHealth).map(([platform, health]) => {
    const mediaSpec = (health as typeof health & { mediaSpec?: { source?: string; version?: string; expiresAt?: string } }).mediaSpec
    return { platform, health, mediaSpec, readiness: opsMediaReadiness({ ready: health.ready, mediaReady: health.mediaUpload?.ready, mediaEvidence: health.mediaUpload?.evidence, evidenceState: evidence.state, sourceRef: mediaSpec?.source ?? evidence.sourceRef, schemaVersion: mediaSpec?.version ?? evidence.schemaVersion, verifiedAt: evidence.verifiedAt, expiresAt: mediaSpec?.expiresAt }) }
  })
  const liveStatus = deliveryLiveStatus(delivery.loading, delivery.error, platformRows.length)
  useEffect(() => {
    if (delivery.loading || !restoreRetryFocus.current) return
    restoreRetryFocus.current = false
    window.requestAnimationFrame(() => (delivery.error ? retryRef.current : panelRef.current)?.focus())
  }, [delivery.error, delivery.loading])
  const retry = () => {
    restoreRetryFocus.current = true
    panelRef.current?.focus()
    void delivery.reload()
  }
  return <div ref={panelRef} tabIndex={-1} className="ops-delivery-governance" aria-label="交付证据治理" aria-busy={model.loading}><Space orientation="vertical" size="middle" style={{ width: '100%' }}>
    <span className="ops-visually-hidden" role="status" aria-live="polite" aria-atomic="true">{liveStatus}</span>
    {delivery.error && <Alert type="error" showIcon role="alert" title="交付证据读取失败" description={`${delivery.error}。缺失项不会显示为通过。`} action={<Button ref={retryRef} onClick={retry}>重试</Button>}/>}
    <Alert type="warning" showIcon title="人工审核、模型预览和脚本不等于交付证据" description="缺少真实性 gate、真实渲染、OCR、人审 attestation 或 bundle 哈希校验时，运营台保持未验证，不显示绿色完成态。" />
    <Card size="small" title="平台媒体规格 readiness">
      {platformRows.length ? <Space orientation="vertical" size="small" style={{ width: '100%' }}>{platformRows.map(row => <Descriptions key={row.platform} bordered size="small" column={{ xs: 1, sm: 2, md: 3 }} title={<Space><span>{platformLabels[row.platform as keyof typeof platformLabels] ?? row.platform}</span><Tag color={row.readiness === 'approved' ? 'green' : row.readiness === 'expired' ? 'red' : 'orange'}>{row.readiness === 'approved' ? 'Approved' : row.readiness === 'expired' ? 'Expired' : '未验证'}</Tag></Space>} items={[
        { key: 'source', label: '来源', children: row.mediaSpec?.source ?? evidence.sourceRef ?? '未提供' },
        { key: 'version', label: '版本', children: row.mediaSpec?.version ?? evidence.schemaVersion ?? '未提供' },
        { key: 'expires', label: '有效期', children: row.mediaSpec?.expiresAt ?? '未提供' },
        { key: 'evidence', label: 'Evidence', children: row.health.mediaUpload?.evidence ? evidence.sourceRef ?? '存在但引用未返回' : '未提供' },
        { key: 'next', label: '下一步', children: row.readiness === 'approved' ? '执行字段 mapping preflight' : '登记并批准带有效期的平台媒体规格，完成 production canary' },
      ]}/>)}</Space> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="健康接口未返回平台媒体规格；所有平台保持未验证"/>}
    </Card>
    {!delivery.error && <DeliveryReadinessCards state={delivery}/>}
  </Space></div>
}
