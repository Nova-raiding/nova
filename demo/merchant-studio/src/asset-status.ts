import type { AssetMetadata } from './api'

export type AssetPrimaryStatus = {
  key: 'scanning' | 'blocked' | 'parsing' | 'rights' | 'facts' | 'ready'
  label: string
  detail: string
  action: 'refresh' | 'manual_review' | 'parse' | 'confirm_rights' | 'confirm_facts' | 'none'
  tone: 'amber' | 'red' | 'blue' | 'green'
}

export type AssetPrimaryAction = {
  kind: AssetPrimaryStatus['action'] | 'upload'
  label: string
  disabled: boolean
}

/** Single merchant-facing status ordered by the safety gate: scan → parse → rights → usable. */
export function resolveAssetPrimaryStatus(asset: AssetMetadata): AssetPrimaryStatus {
  if (!asset.display && asset.readiness?.status !== 'ready') return { key: 'blocked', label: '暂不能确认可用性', detail: '服务端状态投影不可用，请刷新后再继续', action: 'refresh', tone: 'amber' }
  if (asset.readiness?.status === 'blocked' && asset.scanStatus === 'clean' && asset.parseStatus !== 'failed' && asset.rightsStatus !== 'rejected') return { key: 'blocked', label: '当前暂不可用', detail: asset.readiness.reasons[0] || '服务端 readiness 未通过，请查看详情', action: 'manual_review', tone: 'red' }
  if (asset.scanStatus === 'rejected') return { key: 'blocked', label: '安全检查未通过', detail: '请更换文件或联系管理员处理', action: 'manual_review', tone: 'red' }
  if (asset.scanStatus !== 'clean') return { key: 'scanning', label: '安全检查中', detail: '素材仍在隔离区，完成后才能继续', action: 'refresh', tone: 'amber' }
  if (asset.parseStatus === 'failed') return { key: 'blocked', label: '内容读取失败', detail: asset.parseError || '请重试读取或改用人工确认', action: 'manual_review', tone: 'red' }
  if (asset.parseStatus === 'processing') return { key: 'parsing', label: '正在读取内容', detail: '读取完成后再核对素材事实', action: 'refresh', tone: 'blue' }
  if (asset.parseStatus === 'pending') return { key: 'parsing', label: '等待读取内容', detail: '读取完成后再核对素材事实', action: 'parse', tone: 'blue' }
  if (asset.rightsStatus === 'rejected') return { key: 'blocked', label: '使用权益受限', detail: '请确认授权范围或更换素材', action: 'manual_review', tone: 'red' }
  if (asset.rightsStatus !== 'approved') return { key: 'rights', label: '等待确认使用权', detail: '确认商用权益后才能用于生成', action: 'confirm_rights', tone: 'amber' }
  if (!asset.factsConfirmedBy) return { key: 'facts', label: '等待核对素材事实', detail: '请确认素材中明确支持的事实，避免把推测写入内容', action: 'confirm_facts', tone: 'amber' }
  return { key: 'ready', label: '可以用于生成', detail: asset.factsConfirmedBy ? '安全、权益和事实均已确认' : '安全和权益已确认，事实仍可补充核对', action: 'none', tone: 'green' }
}

export function resolveAssetSecondaryStatus(asset: AssetMetadata): string {
  const scan = asset.scanStatus === 'clean' ? '扫描通过' : asset.scanStatus === 'rejected' ? '扫描未通过' : '扫描处理中'
  const rights = asset.rightsStatus === 'approved' ? '权益已确认' : asset.rightsStatus === 'rejected' ? '权益受限' : '权益待确认'
  const facts = asset.factsConfirmedBy ? '事实已确认' : asset.parseStatus === 'succeeded' ? '事实待核对' : '事实未读取'
  return `${scan} · ${rights} · ${facts}`
}

/** The card exposes one next action; all other operations remain secondary. */
export function resolveAssetPrimaryAction(asset: AssetMetadata, options?: { configured?: boolean; busy?: boolean }): AssetPrimaryAction {
  const status = resolveAssetPrimaryStatus(asset)
  const disabled = options?.configured === false || options?.busy === true
  if (status.action === 'refresh') return { kind: 'refresh', label: '刷新状态', disabled }
  if (status.action === 'manual_review' && asset.scanStatus !== 'rejected') return { kind: 'manual_review', label: '人工确认事实', disabled }
  if (status.action === 'manual_review') return { kind: 'upload', label: '重新上传素材', disabled }
  if (status.action === 'parse') return { kind: 'parse', label: '读取素材事实', disabled }
  if (status.action === 'confirm_rights') return { kind: 'confirm_rights', label: '确认商用权益', disabled }
  if (status.action === 'confirm_facts') return { kind: 'confirm_facts', label: '确认素材事实', disabled }
  return { kind: 'none', label: '已可用于生成', disabled: true }
}
