import { useState, type FormEvent } from 'react'
import { Alert, Button, Card, Input, Typography } from 'antd'
import { bootstrapMerchantWorkspace, describeApiError, fetchMerchantSession, type MerchantAuthAccount } from './api.js'

export function workspaceBootstrapRecovery(error: unknown): string {
  const code = (error as { code?: string }).code
  if (code === 'AUTH_SESSION_INVALID' || code === 'AUTH_SESSION_EXPIRED') return '登录状态已失效。请重新登录后再创建工作区。'
  if (code === 'AUTH_CSRF_ORIGIN_INVALID') return '请求来源未通过校验。请从商家工作台原页面重新开始。'
  if (code === 'AUTH_BOOTSTRAP_ACCOUNT_CHANGED') return '账号已绑定工作区或状态已变化。请重新检查登录状态。'
  if (code === 'AUTH_BOOTSTRAP_PRINCIPAL_INVALID' || code === 'WORKSPACE_BOOTSTRAP_BINDING_INACTIVE' || code === 'AUTH_BOOTSTRAP_MEMBERSHIP_INVALID') return '当前身份未满足首次开通条件。请联系平台运营核查账号与工作区绑定。'
  return `首次工作区创建未完成：${describeApiError(error)}。可重试；若账号已由管理员绑定，请重新检查登录状态。`
}

export function MerchantWorkspaceBootstrapPage({
  apiBaseUrl,
  account,
  onComplete,
  onLogout,
}: {
  apiBaseUrl: string
  account: MerchantAuthAccount
  onComplete: (account: MerchantAuthAccount) => void
  onLogout: () => void
}) {
  const [displayName, setDisplayName] = useState(account.enterpriseName?.trim() ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const name = displayName.normalize('NFKC').trim()
    if (!name || name.length > 120 || /[\u0000-\u001f\u007f\u200b-\u200f]/u.test(name)) {
      setError('请填写 1 至 120 个字符的有效企业/工作区名称。')
      return
    }
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const created = await bootstrapMerchantWorkspace(apiBaseUrl, name)
      const session = await fetchMerchantSession(apiBaseUrl)
      if (!session.workspaceIds.includes(created.workspace_id)) throw new Error('工作区创建已返回，但登录会话尚未确认该工作区归属。请重新检查登录状态。')
      onComplete(session)
    } catch (cause) {
      setError(workspaceBootstrapRecovery(cause))
    } finally {
      setBusy(false)
    }
  }

  return <main className="merchant-login-page" aria-labelledby="merchant-workspace-bootstrap-title">
    <section className="merchant-login-form-panel">
      <Card className="merchant-login-card" variant="borderless">
        <div className="merchant-login-card-heading">
          <Typography.Title id="merchant-workspace-bootstrap-title" level={2}>创建首次工作区</Typography.Title>
        </div>
        <Typography.Paragraph>
          商家账号已验证，但尚未绑定工作区。首次创建只会为当前登录账号建立一个工作区和所有者关系；创建后页面、请求和缓存将绑定到该工作区。
        </Typography.Paragraph>
        <form onSubmit={event => void submit(event)} aria-label="首次工作区创建">
          <label htmlFor="merchant-workspace-display-name">企业或工作区名称</label>
          <Input id="merchant-workspace-display-name" value={displayName} maxLength={120} autoComplete="organization" autoFocus disabled={busy} onChange={event => { setDisplayName(event.target.value); setError('') }} />
          {error && <Alert role="alert" type="error" showIcon title="工作区尚未创建" description={error} style={{ marginTop: 16 }} />}
          <div className="merchant-login-actions">
            <Button htmlType="submit" type="primary" loading={busy} disabled={busy || !displayName.trim()}>创建工作区</Button>
            <Button htmlType="button" disabled={busy} onClick={onLogout}>退出登录</Button>
          </div>
        </form>
        <Typography.Text type="secondary">若你的账号应该由平台运营预先绑定工作区，请退出并联系运营核对；不要重复创建。</Typography.Text>
      </Card>
    </section>
  </main>
}
