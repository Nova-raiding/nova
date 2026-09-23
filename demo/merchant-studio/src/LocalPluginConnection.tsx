import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Descriptions, Modal, Select, Space, Tag, Typography } from 'antd'
import { requestApi, type MerchantAuthAccount } from './api.js'

function localLoginOrigin(apiBaseUrl: string): string | null {
  try {
    const base = new URL(apiBaseUrl, typeof window === 'undefined' ? 'https://yxsona.com' : window.location.origin)
    const localHttp = base.protocol === 'http:' && base.hostname === '127.0.0.1'
    if (base.username || base.password || !(base.protocol === 'https:' || localHttp)) return null
    const shellSafeOrigin = /^(?:https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?|http:\/\/127\.0\.0\.1(?::\d{1,5})?)$/u
    if (!shellSafeOrigin.test(base.origin)) return null
    return base.origin
  } catch {
    return null
  }
}

export function localPluginLoginCommand(apiBaseUrl: string, workspaceIds: string[], selectedWorkspaceId?: string, platform: LocalPluginPlatform = 'macos') {
  const candidateWorkspaceId = selectedWorkspaceId ? workspaceIds.includes(selectedWorkspaceId) ? selectedWorkspaceId : null : workspaceIds.length === 1 ? workspaceIds[0] : null
  const workspaceId = candidateWorkspaceId && /^(?:ws_|workspace_)[A-Za-z0-9_-]{1,120}$/u.test(candidateWorkspaceId) ? candidateWorkspaceId : null
  const apiOrigin = localLoginOrigin(apiBaseUrl)
  if (!workspaceId || !apiOrigin) return null
  if (platform === 'macos') return `./runtime/node scripts/login-local-macos.mjs --base-url ${apiOrigin} --workspace ${workspaceId}`
  if (platform === 'windows') return apiOrigin === 'https://yxsona.com'
    ? `login.cmd --workspace ${workspaceId}`
    : `runtime\\node.exe scripts\\login-local-windows.mjs --base-url ${apiOrigin} --workspace ${workspaceId}`
  return null
}

export function localPluginConnectUrl(apiBaseUrl: string, workspaceIds: string[], requestId?: string | null, selectedWorkspaceId?: string) {
  const candidateWorkspaceId = selectedWorkspaceId ? workspaceIds.includes(selectedWorkspaceId) ? selectedWorkspaceId : null : workspaceIds.length === 1 ? workspaceIds[0] : null
  const workspaceId = candidateWorkspaceId && /^(?:ws_|workspace_)[A-Za-z0-9_-]{1,120}$/u.test(candidateWorkspaceId) ? candidateWorkspaceId : null
  const apiOrigin = localLoginOrigin(apiBaseUrl)
  const safeRequestId = requestId == null || /^[A-Za-z0-9_-]{16,128}$/u.test(requestId) ? requestId : null
  if (!workspaceId || !apiOrigin || requestId != null && !safeRequestId) return null
  const query = new URLSearchParams({ api_origin: apiOrigin, workspace: workspaceId })
  if (safeRequestId) query.set('request_id', safeRequestId)
  return `storenova://connect?${query.toString()}`
}

type ConnectionUiState = 'idle' | 'requesting' | 'launching' | 'install_required' | 'connected' | 'expired' | 'failed'
export type LocalPluginPlatform = 'macos' | 'windows' | 'other'

export function detectLocalPluginPlatform(userAgent = '', platform = ''): LocalPluginPlatform {
  const hint = `${platform} ${userAgent}`.toLowerCase()
  if (/win(?:32|64|dows)/u.test(hint)) return 'windows'
  if (/mac(?:intosh|intel|ppc|68k|os)/u.test(hint)) return 'macos'
  return 'other'
}

const connectionStatePresentation: Record<ConnectionUiState, { color: string; label: string }> = {
  idle: { color: 'default', label: '尚未验证' },
  requesting: { color: 'processing', label: '正在创建安全连接' },
  launching: { color: 'processing', label: '正在唤起连接助手' },
  install_required: { color: 'warning', label: '等待本地助手完成' },
  connected: { color: 'success', label: '本地凭据已就绪，待重启验证' },
  expired: { color: 'warning', label: '连接请求已过期' },
  failed: { color: 'error', label: '连接失败，请重试' },
}

interface ConnectRequest {
  request_id: string
  launch_url: string
  expires_at: string
  status: 'pending'
}

interface ConnectRequestStatus {
  request_id?: string
  status: 'pending' | 'authorized' | 'exchanged' | 'expired'
}

export function LocalPluginConnection({ apiBaseUrl, account }: {
  apiBaseUrl: string
  account: MerchantAuthAccount
}) {
  const [openScope, setOpenScope] = useState<string | null>(null)
  const [connectionState, setConnectionState] = useState<ConnectionUiState>('idle')
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | undefined>(account.workspaceIds.length === 1 ? account.workspaceIds[0] : undefined)
  const launchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const connectionAttempt = useRef(0)
  const scope = JSON.stringify([apiBaseUrl, account.id, account.login, account.status, account.workspaceIds])
  const eligible = account.accountType === 'merchant' && account.status === 'active'
  const candidateWorkspaceId = selectedWorkspaceId && account.workspaceIds.includes(selectedWorkspaceId) ? selectedWorkspaceId : null
  const workspaceId = candidateWorkspaceId && /^(?:ws_|workspace_)[A-Za-z0-9_-]{1,120}$/u.test(candidateWorkspaceId) ? candidateWorkspaceId : null
  const connectTargetAvailable = localPluginConnectUrl(apiBaseUrl, account.workspaceIds, undefined, workspaceId ?? undefined) !== null
  // The browser has no paired installation ID. Production requires instance
  // ownership and a signed helper challenge, so keep this prototype action
  // available only against the loopback development API.
  const localPrototypeAvailable = localLoginOrigin(apiBaseUrl)?.startsWith('http://127.0.0.1') === true
  const presentation = connectionStatePresentation[connectionState]
  const platform = detectLocalPluginPlatform(
    typeof navigator === 'undefined' ? '' : navigator.userAgent,
    typeof navigator === 'undefined' ? '' : navigator.platform,
  )
  const command = localPluginLoginCommand(apiBaseUrl, account.workspaceIds, workspaceId ?? undefined, platform)
  const platformLabel = platform === 'macos' ? 'macOS 本地安装版' : platform === 'windows' ? 'Windows 本地安装版' : 'macOS 或 Windows 本地安装版'
  const credentialStore = platform === 'macos' ? 'macOS 钥匙串（Keychain）'
    : platform === 'windows' ? 'Windows 凭据管理器（Credential Manager）'
      : '系统凭据存储（macOS Keychain 或 Windows Credential Manager）'
  const stateLabel = connectionState === 'connected' ? `${credentialStore}已写入，待重启验证`
    : connectionState === 'failed' ? `连接失败，请检查 ${credentialStore}` : presentation.label

  useEffect(() => {
    connectionAttempt.current += 1
    setSelectedWorkspaceId(account.workspaceIds.length === 1 ? account.workspaceIds[0] : undefined)
    setConnectionState('idle')
    return () => {
      if (launchTimer.current) clearTimeout(launchTimer.current)
    }
  }, [scope])

  const beginConnection = async () => {
    if (!workspaceId || !connectTargetAvailable || !localPrototypeAvailable || connectionState === 'requesting') return
    const attempt = ++connectionAttempt.current
    if (launchTimer.current) clearTimeout(launchTimer.current)
    setConnectionState('requesting')
    try {
      const created = await requestApi<ConnectRequest>(apiBaseUrl, '/v1/auth/local-plugin/connect-requests', {
        method: 'POST', body: JSON.stringify({ workspace_id: workspaceId }),
      }, workspaceId)
      if (attempt !== connectionAttempt.current) return
      const expectedLaunchUrl = localPluginConnectUrl(apiBaseUrl, account.workspaceIds, created.request_id, workspaceId)
      if (!expectedLaunchUrl || created.status !== 'pending' || created.launch_url !== expectedLaunchUrl
        || !Number.isFinite(new Date(created.expires_at).getTime()) || new Date(created.expires_at).getTime() <= Date.now()) throw new Error('INVALID_CONNECT_REQUEST')
      setConnectionState('launching')
      window.location.assign(created.launch_url)
      const poll = async () => {
        try {
          const status = await requestApi<ConnectRequestStatus>(apiBaseUrl,
            `/v1/auth/local-plugin/connect-requests/${encodeURIComponent(created.request_id)}/status?workspace_id=${encodeURIComponent(workspaceId)}`, {}, workspaceId)
          if (attempt !== connectionAttempt.current) return
          if (status.request_id !== undefined && status.request_id !== created.request_id) throw new Error('INVALID_CONNECT_STATUS')
          if (status.status === 'exchanged') { setConnectionState('connected'); return }
          if (status.status === 'expired' || Date.now() >= new Date(created.expires_at).getTime()) { setConnectionState('expired'); return }
          setConnectionState('install_required')
          launchTimer.current = setTimeout(poll, 2_000)
        } catch { if (attempt === connectionAttempt.current) setConnectionState('failed') }
      }
      launchTimer.current = setTimeout(poll, 2_000)
    } catch {
      if (attempt === connectionAttempt.current) setConnectionState('failed')
    }
  }

  if (!eligible) return null
  return <>
    <Space size={6} wrap>
      {account.workspaceIds.length > 1 && <Select
        aria-label="选择插件工作区"
        placeholder="选择工作区"
        style={{ minWidth: 210 }}
        value={workspaceId ?? undefined}
        options={account.workspaceIds.filter(id => /^(?:ws_|workspace_)[A-Za-z0-9_-]{1,120}$/u.test(id)).map(id => ({ label: id, value: id }))}
        onChange={id => { connectionAttempt.current += 1; if (launchTimer.current) clearTimeout(launchTimer.current); setSelectedWorkspaceId(id); setConnectionState('idle') }}
      />}
      <Button type="primary" disabled={!connectTargetAvailable || !localPrototypeAvailable || connectionState === 'requesting' || connectionState === 'launching' || connectionState === 'install_required'} loading={connectionState === 'requesting'} onClick={beginConnection}>连接 ChatGPT 本地插件</Button>
      <Tag color={presentation.color}>{stateLabel}</Tag>
      <Button type="link" onClick={() => setOpenScope(scope)}>安装与故障帮助</Button>
    </Space>
    <Modal title="连接本地插件" wrapClassName="merchant-local-plugin-modal" open={openScope === scope} onCancel={() => setOpenScope(null)} destroyOnHidden footer={
      <Button onClick={(event) => { event.stopPropagation(); setOpenScope(null) }}>关闭</Button>
    }>
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        <Alert type={localPrototypeAvailable ? 'info' : 'warning'} title={localPrototypeAvailable ? '一键连接需要已安装的 Store Nova Helper' : '生产一键连接尚未开放'} showIcon description={localPrototypeAvailable ? '主按钮只会通过 storenova:// 协议唤起本机助手；链接中没有密码、token 或授权码。点击按钮不代表插件已经安装或连接成功。' : '生产连接必须由已配对的安装实例提供持有证明；当前网页没有安装实例 ID，因此连接按钮已禁用。请在可信插件目录使用下方本地登录命令完成工作区授权，并在 ChatGPT 内验证连接。'} />
        <Descriptions size="small" column={1} items={[
          { key: 'account', label: '当前登录账号', children: account.login },
          { key: 'workspace', label: '目标工作区', children: workspaceId ?? '请先选择当前账号已授权的工作区' },
          { key: 'platform', label: '当前系统指引', children: platformLabel },
          { key: 'credential-store', label: '凭据保存位置', children: credentialStore },
        ]} />
        {command ? <>
          <Typography.Paragraph style={{ margin: 0 }}>请先确认本地插件来自可信安装包，再在安装包目录运行工作区登录命令：</Typography.Paragraph>
          <Typography.Paragraph copyable={false} style={{ margin: 0 }}><Typography.Text code>{command}</Typography.Text></Typography.Paragraph>
          <Typography.Paragraph style={{ margin: 0 }}>命令会打开商家浏览器完成授权，并把凭据写入{credentialStore}。完成后仍需重启 ChatGPT，并在新会话中调用 <Typography.Text code>onboarding.status</Typography.Text> 验证；验证通过前不要视为已连接。</Typography.Paragraph>
        </> : <Alert type="warning" showIcon title="无法生成安全的本地登录命令" description="请选择已授权的工作区，并确认 HTTPS API 地址有效。" />}
        <Typography.Text type="secondary">不要从此页面下载脚本，不要执行远程 curl 管道命令，也不要把 token、密码或授权地址粘贴到聊天或配置文件。</Typography.Text>
      </Space>
    </Modal>
  </>
}
