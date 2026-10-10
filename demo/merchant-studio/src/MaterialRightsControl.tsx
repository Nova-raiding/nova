import { useState } from 'react'
import { Button, Checkbox, Form, Modal, Select } from 'antd'
import { updateAssetRights, type AssetMetadata } from './api.js'
import { rightsConfirmationPayload, rightsScopeForConfirmation } from './asset-status.js'
import './material-rights-control.css'

const scopeLabels: Record<string, string> = {
  owned: '自有素材',
  commercial_authorized: '已获商用授权',
  limited_use: '受限使用',
  internal_only: '仅内部使用',
}

function savedScopeLabel(asset: AssetMetadata): string {
  if (asset.rightsStatus !== 'approved') return asset.rightsStatus === 'rejected' ? '权益未通过' : '权益待确认'
  if (asset.rightsScope === 'internal_only') return '仅内部使用，不可用于生成'
  if (asset.rightsScope === 'limited_use') return '使用范围受限，不可用于生成'
  if (asset.rightsScope === 'unusable') return '当前不可使用'
  return '商用权益已确认'
}

/** Merchant-visible, server-backed rights control for the current material cards. */
export function MaterialRightsControl({
  asset,
  baseUrl,
  onSaved,
}: {
  asset: AssetMetadata
  baseUrl?: string
  onSaved: (asset: AssetMetadata) => void
}) {
  const [open, setOpen] = useState(false)
  const [scope, setScope] = useState(rightsScopeForConfirmation(asset))
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // The server projection decides whether a rights write is allowed. A clean
  // label without a current allowed action is not enough evidence to enable it.
  const allowed = Boolean(baseUrl)
    && asset.scanStatus === 'clean'
    && asset.display?.nextAction?.method === 'asset.rights.update'
    && asset.display.nextAction.allowed
  const actionLabel = asset.rightsStatus === 'approved' ? '调整权益范围' : '确认权益范围'
  const selectableScopes = asset.rightsScope === 'owned' || asset.rightsScope === 'commercial_authorized'
    ? Object.entries(scopeLabels)
    : asset.rightsScope === 'limited_use'
      ? (['limited_use', 'internal_only'] as const).map((value) => [value, scopeLabels[value]] as const)
      : ([['internal_only', scopeLabels.internal_only]] as const)

  const openDialog = () => {
    setScope(rightsScopeForConfirmation(asset))
    setAcknowledged(false)
    setError('')
    setOpen(true)
  }

  const save = async () => {
    if (!baseUrl || !allowed || busy || !acknowledged) return
    setBusy(true)
    setError('')
    try {
      const updated = await updateAssetRights(baseUrl, asset.id, rightsConfirmationPayload(scope))
      onSaved(updated)
      setOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '权益保存失败，请重试。')
    } finally {
      setBusy(false)
    }
  }

  return <div className="material-rights-control" data-testid={`material-rights-${asset.id}`}>
    <span className={asset.rightsStatus === 'approved' && !['internal_only', 'limited_use', 'unusable'].includes(asset.rightsScope ?? '') ? 'material-rights-status approved' : 'material-rights-status restricted'} role="status">
      {savedScopeLabel(asset)}
    </span>
    <Button size="small" disabled={!allowed} aria-label={`${actionLabel}：${asset.name}`} onClick={openDialog}>
      {actionLabel}
    </Button>
    {!allowed && <small className="material-rights-blocker">{!baseUrl ? 'API 尚未配置' : asset.scanStatus !== 'clean' ? '扫描通过前不能确认权益' : '服务端尚未允许编辑权益'}</small>}
    <Modal
      title={`${actionLabel}：“${asset.name}”`}
      open={open}
      onCancel={() => { if (!busy) setOpen(false) }}
      okText="保存权益范围"
      cancelText="取消"
      confirmLoading={busy}
      okButtonProps={{ disabled: !allowed || !acknowledged }}
      onOk={() => void save()}
      destroyOnHidden
      data-testid="material-rights-dialog"
    >
      <Form layout="vertical">
        <Form.Item label="权益范围">
          <Select
            aria-label="选择权益范围"
            value={scope}
            onChange={setScope}
            options={selectableScopes.map(([value, label]) => ({ value, label }))}
          />
        </Form.Item>
        <p role="note">“受限使用”和“仅内部使用”只记录对应范围，不会授予商用或 AI 生成权限。请以合同或授权证明为准；AI 改图许可仍需单独确认。</p>
        <Checkbox checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)}>
          我已核对授权证明，并确认所选权益范围准确
        </Checkbox>
        {error && <p role="alert">权益保存失败：{error}</p>}
      </Form>
    </Modal>
  </div>
}
