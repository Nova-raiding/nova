import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Descriptions, Modal, Select, Space, Tag, Typography } from 'antd'
import { requestApi, type ApiError, type MerchantAuthAccount } from './api.js'

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

export function localPluginEnrollUrl(apiBaseUrl: string, workspaceIds: string[], selectedWorkspaceId?: string, accountId?: string) {
  const workspaceId = selectedWorkspaceId && workspaceIds.includes(selectedWorkspaceId) ? selectedWorkspaceId : workspaceIds.length === 1 ? workspaceIds[0] : null
  const origin = localLoginOrigin(apiBaseUrl)
  if (!origin || !workspaceId || !/^(?:ws_|workspace_)[A-Za-z0-9_-]{1,120}$/u.test(workspaceId)
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(accountId ?? '')) return null
  return `storenova://enroll?${new URLSearchParams({ api_origin: origin, workspace: workspaceId, account_id: accountId! })}`
}

type PairingReturn = { installation_id: string; pairing_token: string; workspace_id: string; expires_at: string }
export function parsePluginPairFragment(hash: string, workspaceIds: string[]): PairingReturn | null {
  if (!hash.startsWith('#plugin_pair=') || hash.length > 2048) return null
  try {
    const encoded = hash.slice('#plugin_pair='.length)
    if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) return null
    const json = atob(encoded.replaceAll('-', '+').replaceAll('_', '/'))
    const pair = JSON.parse(new TextDecoder().decode(Uint8Array.from(json, character => character.charCodeAt(0)))) as PairingReturn
    if (!/^[0-9a-f-]{36}$/iu.test(pair.installation_id)
      || !/^[A-Za-z0-9_-]{43}$/u.test(pair.pairing_token)
      || !workspaceIds.includes(pair.workspace_id)
      || !Number.isFinite(Date.parse(pair.expires_at)) || Date.parse(pair.expires_at) <= Date.now()) return null
    return pair
  } catch { return null }
}

export function pairingMatchesWorkspace(pairing: PairingReturn | null, workspaceId: string | null): boolean {
  return Boolean(pairing && workspaceId && pairing.workspace_id === workspaceId)
}

type ConnectionUiState = 'idle' | 'requesting' | 'launching' | 'install_required' | 'confirmation_pending' | 'connected' | 'expired' | 'failed'
type OneClickState = 'checking' | 'available' | 'release_gate' | 'schema_upgrade' | 'production_mode' | 'unsupported_platform' | 'workspace_required' | 'workspace_mismatch' | 'auth_required' | 'check_failed'

type CapabilityReadApi = <T>(baseUrl: string, path: string, init?: RequestInit, workspaceId?: string) => Promise<T>

export async function readLocalPluginCapability(apiBaseUrl: string, workspaceId: string, readApi: CapabilityReadApi = requestApi) {
  try {
    const result = await readApi<{ one_click_available: boolean; supported_platforms: string[]; unavailable_reason?: string }>(
      apiBaseUrl, '/v1/auth/local-plugin/connect-capability', {}, workspaceId,
    )
    return result.one_click_available === true && result.supported_platforms?.includes('macos') === true
      ? 'available' as const
      : result.unavailable_reason === 'auth_required'
        ? 'auth_required' as const
        : result.unavailable_reason === 'schema_upgrade'
          ? 'schema_upgrade' as const
          : result.unavailable_reason === 'production_mode'
            ? 'production_mode' as const
            : Array.isArray(result.supported_platforms) && !result.supported_platforms.includes('macos')
              ? 'unsupported_platform' as const
              : 'release_gate' as const
  } catch (error) {
    const code = (error as ApiError)?.code
    if (code === 'AUTH_SESSION_INVALID' || code === 'AUTH_SESSION_EXPIRED') return 'auth_required' as const
    if (code === 'MCP_OAUTH_WORKSPACE_AMBIGUOUS' || code === 'API_WORKSPACE_CONTEXT_MISMATCH' || code === 'API_WORKSPACE_CONTEXT_CHANGED' || code === 'API_WORKSPACE_NOT_AUTHORIZED') return 'workspace_mismatch' as const
    if (code === 'API_WORKSPACE_SCOPE_REQUIRED') return 'workspace_required' as const
    throw error
  }
}

export function LocalPluginCapabilityRetryButton({ visible, loading, onRetry }: {
  visible: boolean
  loading: boolean
  onRetry: () => void
}) {
  if (!visible) return null
  return <Button type="link" size="small" aria-label="重新检查一键连接" loading={loading} disabled={loading} onClick={onRetry}>重新检查一键连接</Button>
}

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
  confirmation_pending: { color: 'processing', label: '凭据已签发，等待本机保存确认' },
  connected: { color: 'success', label: '本地绑定已完成，请重启 ChatGPT 验证' },
  expired: { color: 'warning', label: '连接请求已过期' },
  failed: { color: 'error', label: '连接失败，请重试' },
}

interface ConnectRequest {
  request_id: string
  launch_url: string
  expires_at: string
  status: 'pending'
  account_id?: string
  installation_id?: string
  challenge_id?: string
  server_nonce?: string
  challenge_issued_at?: string
  challenge_expires_at?: string
}

interface ConnectRequestStatus {
  request_id?: string
  status: 'pending' | 'authorized' | 'exchanged' | 'expired'
  local_binding_complete?: boolean
}

export function LocalPluginConnection({ apiBaseUrl, account, activeWorkspaceId, onWorkspaceChange }: {
  apiBaseUrl: string
  account: MerchantAuthAccount
  activeWorkspaceId: string | null
  onWorkspaceChange: (workspaceId: string) => void
}) {
  const [openScope, setOpenScope] = useState<string | null>(null)
  const [connectionState, setConnectionState] = useState<ConnectionUiState>('idle')
  const [pairing, setPairing] = useState<PairingReturn | null>(null)
  const [oneClickState, setOneClickState] = useState<OneClickState>('checking')
  const launchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const connectionAttempt = useRef(0)
  const capabilityReadAttempt = useRef(0)
  const scope = JSON.stringify([apiBaseUrl, account.id, account.login, account.status, account.workspaceIds, activeWorkspaceId])
  const eligible = account.accountType === 'merchant' && account.status === 'active'
  const candidateWorkspaceId = activeWorkspaceId && account.workspaceIds.includes(activeWorkspaceId) ? activeWorkspaceId : null
  const workspaceId = candidateWorkspaceId && /^(?:ws_|workspace_)[A-Za-z0-9_-]{1,120}$/u.test(candidateWorkspaceId) ? candidateWorkspaceId : null
  const connectTargetAvailable = localPluginConnectUrl(apiBaseUrl, account.workspaceIds, undefined, workspaceId ?? undefined) !== null
  const origin = localLoginOrigin(apiBaseUrl)
  const localPlatform = detectLocalPluginPlatform(
    typeof navigator === 'undefined' ? '' : navigator.userAgent,
    typeof navigator === 'undefined' ? '' : navigator.platform,
  )
  const macosBrowser = localPlatform === 'macos'
  const localPlatformLabel = localPlatform === 'windows' ? 'Windows' : 'macOS'
  const presentation = oneClickState === 'release_gate'
    ? { color: 'warning', label: '需安装已验证助手' }
    : oneClickState === 'auth_required'
      ? { color: 'error', label: '登录已失效' }
      : oneClickState === 'workspace_mismatch'
        ? { color: 'warning', label: '工作区不匹配' }
        : oneClickState === 'workspace_required'
          ? { color: 'warning', label: '需选择工作区' }
          : oneClickState === 'check_failed'
            ? { color: 'error', label: '无法确认连接状态' }
            : oneClickState === 'unsupported_platform'
              ? { color: 'warning', label: '平台不受支持' }
              : oneClickState === 'schema_upgrade'
                ? { color: 'warning', label: '服务升级中' }
                : oneClickState === 'production_mode'
                  ? { color: 'warning', label: '本地插件未启用' }
                  : oneClickState === 'checking'
                    ? { color: 'processing', label: '正在检查连接' }
    : connectionStatePresentation[connectionState]
  const oneClickAvailable = oneClickState === 'available'
  // Keep the entry point actionable when the server has deliberately gated
  // one-click.  Clicking it opens the recovery/help modal; it never creates a
  // connection request unless the server has advertised the signed helper as
  // available.  During capability discovery (or without a valid workspace),
  // keep the button disabled so an incomplete target cannot be submitted.
  const connectionButtonDisabled = !connectTargetAvailable
    || ['checking', 'unsupported_platform', 'workspace_required', 'workspace_mismatch'].includes(oneClickState)
    || connectionState === 'requesting' || connectionState === 'launching'
  const loginCommand = localPluginLoginCommand(apiBaseUrl, account.workspaceIds, workspaceId ?? undefined, localPlatform)
  const oneClickUnavailableReason = oneClickState === 'release_gate'
    ? '一键连接需要已安装并通过验证的桌面连接助手；当前发布门禁尚未完成。请安装平台提供的签名版连接助手，或使用下方本地登录命令。'
    : oneClickState === 'schema_upgrade'
      ? '当前服务正在升级，完成数据库升级后才能启用一键连接。'
      : oneClickState === 'production_mode'
        ? '当前部署未启用本地插件凭据，请联系管理员检查本地插件集成模式。'
        : oneClickState === 'unsupported_platform'
      ? '一键连接目前仅支持 macOS 桌面端。'
      : oneClickState === 'workspace_required'
        ? '请先选择要连接的工作区。'
        : oneClickState === 'workspace_mismatch'
          ? '当前连接请求与所选工作区不一致，请切换到账号已授权的工作区后重试。'
        : oneClickState === 'auth_required'
          ? '商家后台登录会话已失效，请先重新登录后再连接本地插件。'
        : oneClickState === 'check_failed'
          ? '暂时无法确认一键连接状态，请打开安装与故障帮助。'
          : '正在检查一键连接是否可用。'

  const handleConnectClick = () => {
    if (!oneClickAvailable) {
      setOpenScope(scope)
      return
    }
    void beginConnection()
  }

  useEffect(() => {
    connectionAttempt.current += 1
    setConnectionState('idle')
    return () => {
      if (launchTimer.current) clearTimeout(launchTimer.current)
    }
  }, [scope])

  useEffect(() => {
    let active = true
    const attempt = ++capabilityReadAttempt.current
    if (!macosBrowser) setOneClickState('unsupported_platform')
    else if (!workspaceId) setOneClickState('workspace_required')
    else if (eligible) {
      setOneClickState('checking')
      void readLocalPluginCapability(apiBaseUrl, workspaceId).then(state => {
        if (active && capabilityReadAttempt.current === attempt) setOneClickState(state)
      }).catch(() => {
        if (active && capabilityReadAttempt.current === attempt) setOneClickState('check_failed')
      })
    }
    return () => { active = false; capabilityReadAttempt.current += 1 }
  }, [scope, workspaceId, eligible, macosBrowser, apiBaseUrl])

  const retryCapabilityRead = () => {
    if (oneClickState !== 'check_failed' || !macosBrowser || !eligible || !workspaceId) return
    const attempt = ++capabilityReadAttempt.current
    setOneClickState('checking')
    void readLocalPluginCapability(apiBaseUrl, workspaceId).then(state => {
      if (capabilityReadAttempt.current === attempt) setOneClickState(state)
    }).catch(() => {
      if (capabilityReadAttempt.current === attempt) setOneClickState('check_failed')
    })
  }

  useEffect(() => {
    const fragment = window.location.hash
    if (!fragment.startsWith('#plugin_pair=')) return
    const parsed = parsePluginPairFragment(fragment, account.workspaceIds)
    if (parsed) {
      setPairing(parsed)
      setOpenScope(scope)
      // A callback never silently changes the active tenant. Keep the pairing
      // fragment until the merchant selects its authorized workspace globally.
      if (parsed.workspace_id === workspaceId) window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`)
    }
    else {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`)
      setConnectionState('failed')
    }
  }, [scope, account.workspaceIds, workspaceId])

  const installationKey = workspaceId && origin ? `storenova.plugin.installation:${origin}:${account.id}:${workspaceId}` : null

  const completePairing = async () => {
    if (!pairing || !pairingMatchesWorkspace(pairing, workspaceId) || !installationKey) return
    try {
      const result = await requestApi<{ installation_id: string; paired: boolean }>(apiBaseUrl,
        '/v1/auth/local-plugin/install-instances/pair', {
          method: 'POST', body: JSON.stringify({ installation_id: pairing.installation_id,
            pairing_token: pairing.pairing_token, workspace_id: pairing.workspace_id }),
        }, pairing.workspace_id)
      if (!result.paired || result.installation_id !== pairing.installation_id) throw new Error('PAIRING_INVALID')
      window.localStorage.setItem(installationKey, result.installation_id)
      setPairing(null)
      setOpenScope(null)
      setConnectionState('idle')
      void beginConnection(result.installation_id)
    } catch { setConnectionState('failed') }
  }

  const beginConnection = async (pairedInstallationId?: string) => {
    if ((!oneClickAvailable && !pairedInstallationId) || !workspaceId || !connectTargetAvailable || !installationKey || connectionState === 'requesting') return
    setOpenScope(scope)
    const installationId = pairedInstallationId ?? window.localStorage.getItem(installationKey)
    if (!installationId) {
      const enrollUrl = localPluginEnrollUrl(apiBaseUrl, account.workspaceIds, workspaceId, account.id)
      if (!enrollUrl) { setConnectionState('failed'); return }
      setConnectionState('launching')
      window.location.assign(enrollUrl)
      launchTimer.current = setTimeout(() => setConnectionState('install_required'), 3_000)
      return
    }
    const attempt = ++connectionAttempt.current
    if (launchTimer.current) clearTimeout(launchTimer.current)
    setConnectionState('requesting')
    try {
      const created = await requestApi<ConnectRequest>(apiBaseUrl, '/v1/auth/local-plugin/connect-requests', {
        method: 'POST', body: JSON.stringify({ workspace_id: workspaceId, installation_id: installationId }),
      }, workspaceId)
      if (attempt !== connectionAttempt.current) return
      const expectedBase = localPluginConnectUrl(apiBaseUrl, account.workspaceIds, created.request_id, workspaceId)
      const expectedLaunch = expectedBase ? new URL(expectedBase) : null
      if (expectedLaunch && created.account_id === account.id && created.installation_id === installationId
        && created.challenge_id && created.server_nonce && created.challenge_issued_at && created.challenge_expires_at) {
        for (const [key, value] of Object.entries({ account_id: created.account_id, installation_id: installationId,
          challenge_id: created.challenge_id, server_nonce: created.server_nonce,
          challenge_issued_at: created.challenge_issued_at, challenge_expires_at: created.challenge_expires_at })) {
          expectedLaunch.searchParams.set(key, value)
        }
      }
      if (!expectedLaunch || created.status !== 'pending' || created.launch_url !== expectedLaunch.toString()
        || !Number.isFinite(new Date(created.expires_at).getTime()) || new Date(created.expires_at).getTime() <= Date.now()) throw new Error('INVALID_CONNECT_REQUEST')
      setConnectionState('launching')
      window.location.assign(created.launch_url)
      const poll = async () => {
        try {
          const status = await requestApi<ConnectRequestStatus>(apiBaseUrl,
            `/v1/auth/local-plugin/connect-requests/${encodeURIComponent(created.request_id)}/status?workspace_id=${encodeURIComponent(workspaceId)}`, {}, workspaceId)
          if (attempt !== connectionAttempt.current) return
          if (status.request_id !== undefined && status.request_id !== created.request_id) throw new Error('INVALID_CONNECT_STATUS')
          // Older APIs mark `exchanged` as soon as they issue a token. Only a
          // post-save installer acknowledgement can confirm the local binding.
          if (status.local_binding_complete === true) { setConnectionState('connected'); return }
          if (status.status === 'expired' || Date.now() >= new Date(created.expires_at).getTime()) { setConnectionState('expired'); return }
          setConnectionState(status.status === 'exchanged' ? 'confirmation_pending' : 'install_required')
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
        onChange={id => { connectionAttempt.current += 1; if (launchTimer.current) clearTimeout(launchTimer.current); onWorkspaceChange(id); setConnectionState('idle') }}
      />}
      <Button type="primary" disabled={connectionButtonDisabled} loading={connectionState === 'requesting'} onClick={handleConnectClick}>连接 ChatGPT 本地插件</Button>
      <Tag color={presentation.color}>{presentation.label}</Tag>
      <Button type="link" onClick={() => setOpenScope(scope)}>安装与故障帮助</Button>
      {!oneClickAvailable && <Typography.Text type={oneClickState === 'release_gate' || oneClickState === 'schema_upgrade' || oneClickState === 'production_mode' || oneClickState === 'workspace_mismatch' || oneClickState === 'check_failed' ? 'warning' : 'secondary'}>{oneClickUnavailableReason}</Typography.Text>}
      {oneClickState === 'auth_required' && <Button type="default" href="/merchant/login">重新登录商家后台</Button>}
      {oneClickState !== 'auth_required' && oneClickState !== 'workspace_mismatch' && !oneClickAvailable && loginCommand && <Button type="default" onClick={() => setOpenScope(scope)}>使用本地登录命令</Button>}
      {oneClickState !== 'auth_required' && oneClickState !== 'workspace_mismatch' && !oneClickAvailable && loginCommand && <Typography.Text code copyable={{ text: loginCommand }} style={{ maxWidth: '100%' }}>{loginCommand}</Typography.Text>}
      <LocalPluginCapabilityRetryButton visible={oneClickState === 'check_failed'} loading={oneClickState === 'checking'} onRetry={retryCapabilityRead} />
    </Space>
    <Modal title="连接本地插件" wrapClassName="merchant-local-plugin-modal" open={openScope === scope} onCancel={() => setOpenScope(null)} destroyOnHidden footer={
      <Button onClick={(event) => { event.stopPropagation(); setOpenScope(null) }}>关闭</Button>
    }>
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        <Alert type={connectionState === 'connected' ? 'success' : connectionState === 'failed' ? 'error' : connectionState === 'expired' ? 'warning' : 'info'}
          title={presentation.label} showIcon
          description={connectionState === 'connected'
            ? `安装器已确认将账号 ${account.login} 对目标工作区 ${workspaceId ?? '当前所选工作区'} 的凭据保存到这台电脑。请完全退出并重新打开 ChatGPT，再在新对话中检查 Store Nova 连接。`
            : connectionState === 'confirmation_pending'
              ? '服务端已完成凭据交换，正在等待本地安装器确认保存。收到授权回调本身不代表绑定成功。'
              : connectionState === 'expired' || connectionState === 'failed'
                ? '本次连接未完成。请检查本地安装器提示后重新连接。'
                : '请保持商家工作台打开。授权页会在另一个标签页完成验证，本页面会显示绑定进度。'} />
        {pairing
          ? <Alert type={pairingMatchesWorkspace(pairing, workspaceId) ? 'info' : 'warning'} title={pairingMatchesWorkspace(pairing, workspaceId) ? '确认连接这台电脑' : '请先切换到授权工作区'} showIcon description={pairingMatchesWorkspace(pairing, workspaceId) ? `将工作区 ${pairing.workspace_id} 授权给刚打开的 Store Nova 本地插件。` : `该连接回调属于工作区 ${pairing.workspace_id}。关闭此窗口，在页面顶部切换到该工作区后再打开连接确认。`} />
          : oneClickAvailable
            ? <Alert type="info" title="点击连接并按浏览器提示打开本地插件" showIcon description="首次连接需确认这台电脑。若浏览器提示没有应用可打开，请先安装平台提供的桌面插件包。" />
            : <Alert type={oneClickState === 'auth_required' ? 'error' : 'warning'} title={oneClickState === 'auth_required' ? '需要重新登录' : '一键连接暂未开放'} showIcon description={oneClickUnavailableReason} />}
        <Descriptions size="small" column={1} items={[
          { key: 'account', label: '当前登录账号', children: account.login },
          { key: 'workspace', label: '目标工作区', children: workspaceId ?? '请先选择当前账号已授权的工作区' },
        ]} />
        {oneClickState === 'auth_required' && <Button type="primary" href="/merchant/login">重新登录商家后台</Button>}
        {pairing && <Button type="primary" disabled={!pairingMatchesWorkspace(pairing, workspaceId) || !installationKey} onClick={() => { void completePairing() }}>确认连接这台电脑</Button>}
        {oneClickState !== 'auth_required' && oneClickState !== 'workspace_mismatch' && !oneClickAvailable && loginCommand && <Alert type="info" title="本地验证恢复路径" showIcon description={<Space orientation="vertical" size={4}>
          <Typography.Text>优先重新运行平台提供的 {localPlatformLabel} 安装包。维护人员或旧版安装可在插件目录运行：</Typography.Text>
          <Typography.Text code copyable>{loginCommand}</Typography.Text>
          <Typography.Text type="secondary">此命令使用本地 stdio 插件链路，不需要 ChatGPT OAuth 或插件市场授权。</Typography.Text>
          <Typography.Text type="secondary">运行前请确认商家后台登录账号为 {account.login}，授权页显示目标工作区 {workspaceId}。浏览器授权完成后，还要等待安装器确认本机凭据保存成功；然后完全退出并重新打开 ChatGPT。</Typography.Text>
        </Space>} />}
        <Typography.Paragraph style={{ margin: 0 }}>本机凭据保存成功后，完全退出并重新打开 ChatGPT。在新对话中说“检查 Store Nova 插件是否已连接”即可。</Typography.Paragraph>
      </Space>
    </Modal>
  </>
}
