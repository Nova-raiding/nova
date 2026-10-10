type BrandScopeSaveControlsProps = {
  dirty: boolean
  busy: boolean
  loading: boolean
  revision: number | null
  error: string
  saved: string
  needsRefresh: boolean
  onSave: () => void
  onRefresh: () => void
}

export function BrandScopeSaveControls({ dirty, busy, loading, revision, error, saved, needsRefresh, onSave, onRefresh }: BrandScopeSaveControlsProps) {
  return <div className="material-library-brand-save" aria-label="品牌配置保存操作">
    {(dirty || loading) && <button type="button" className="material-upload-button" disabled={busy || loading || needsRefresh} onClick={onSave}>{loading ? '正在读取品牌配置…' : busy ? '正在保存…' : '保存品牌配置'}</button>}
    {needsRefresh && <button type="button" disabled={loading || busy} onClick={onRefresh}>{loading ? '正在重新读取…' : '重新读取最新版本'}</button>}
    {(error || saved || (!dirty && !loading && revision !== null)) && <span role="status">{error || saved || `当前服务端版本：${revision}`}</span>}
  </div>
}
