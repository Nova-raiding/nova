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

type ConnectionUiState = 'idle' | 'requesting' | 'launching' | 'install_required' | 'confirmation_pending' | 'connected' | 'expired' | 'failed'
type OneClickState = 'checking' | 'available' | 'release_gate' | 'unsupported_platform' | 'workspace_required' | 'check_failed'
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

export function LocalPluginConnection({ apiBaseUrl, account }: {
  apiBaseUrl: string
  account: MerchantAuthAccount
}) {
  const [openScope, setOpenScope] = useState<string | null>(null)
  const [connectionState, setConnectionState] = useState<ConnectionUiState>('idle')
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | undefined>(account.workspaceIds.length === 1 ? account.workspaceIds[0] : undefined)
  const [pairing, setPairing] = useState<PairingReturn | null>(null)
  const [oneClickState, setOneClickState] = useState<OneClickState>('checking')
  const launchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const connectionAttempt = useRef(0)
  const scope = JSON.stringify([apiBaseUrl, account.id, account.login, account.status, account.workspaceIds])
  const eligible = account.accountType === 'merchant' && account.status === 'active'
  const candidateWorkspaceId = selectedWorkspaceId && account.workspaceIds.includes(selectedWorkspaceId) ? selectedWorkspaceId : null
  const workspaceId = candidateWorkspaceId && /^(?:ws_|workspace_)[A-Za-z0-9_-]{1,120}$/u.test(candidateWorkspaceId) ? candidateWorkspaceId : null
  const connectTargetAvailable = localPluginConnectUrl(apiBaseUrl, account.workspaceIds, undefined, workspaceId ?? undefined) !== null
  const origin = localLoginOrigin(apiBaseUrl)
  const macosBrowser = detectLocalPluginPlatform(
    typeof navigator === 'undefined' ? '' : navigator.userAgent,
    typeof navigator === 'undefined' ? '' : navigator.platform,
  ) === 'macos'
  const presentation = connectionStatePresentation[connectionState]
  const oneClickAvailable = oneClickState === 'available'
  const loginCommand = localPluginLoginCommand(apiBaseUrl, account.workspaceIds, workspaceId ?? undefined, 'macos')
  const oneClickUnavailableReason = oneClickState === 'release_gate'
    ? '生产发布门禁尚未通过，暂不能启用一键连接。'
    : oneClickState === 'unsupported_platform'
      ? '一键连接目前仅支持 macOS 桌面端。'
      : oneClickState === 'workspace_required'
        ? '请先选择要连接的工作区。'
        : oneClickState === 'check_failed'
          ? '暂时无法确认一键连接状态，请打开安装与故障帮助。'
          : '正在检查一键连接是否可用。'

  useEffect(() => {
    connectionAttempt.current += 1
    setSelectedWorkspaceId(account.workspaceIds.length === 1 ? account.workspaceIds[0] : undefined)
    setConnectionState('idle')
    return () => {
      if (launchTimer.current) clearTimeout(launchTimer.current)
    }
  }, [scope])

  useEffect(() => {
    let active = true
    if (!macosBrowser) setOneClickState('unsupported_platform')
    else if (!workspaceId) setOneClickState('workspace_required')
    else if (eligible) {
      setOneClickState('checking')
      void requestApi<{ one_click_available: boolean; supported_platforms: string[] }>(apiBaseUrl,
        '/v1/auth/local-plugin/connect-capability', {}, workspaceId ?? undefined)
        .then(result => { if (active) setOneClickState(result.one_click_available === true && result.supported_platforms?.includes('macos') === true ? 'available' : 'release_gate') })
        .catch(() => { if (active) setOneClickState('check_failed') })
    }
    return () => { active = false }
  }, [scope, workspaceId, eligible, macosBrowser, apiBaseUrl])

  useEffect(() => {
    const fragment = window.location.hash
    if (!fragment.startsWith('#plugin_pair=')) return
    const parsed = parsePluginPairFragment(fragment, account.workspaceIds)
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`)
    if (parsed) { setPairing(parsed); setOpenScope(scope) }
    else setConnectionState('failed')
  }, [scope, account.workspaceIds])

  const installationKey = workspaceId && origin ? `storenova.plugin.installation:${origin}:${account.id}:${workspaceId}` : null

  const completePairing = async () => {
    if (!pairing || !installationKey) return
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
        onChange={id => { connectionAttempt.current += 1; if (launchTimer.current) clearTimeout(launchTimer.current); setSelectedWorkspaceId(id); setConnectionState('idle') }}
      />}
      <Button type="primary" disabled={!oneClickAvailable || !connectTargetAvailable || connectionState === 'requesting' || connectionState === 'launching'} loading={connectionState === 'requesting'} onClick={() => { void beginConnection() }}>连接 ChatGPT 本地插件</Button>
      <Tag color={presentation.color}>{presentation.label}</Tag>
      <Button type="link" onClick={() => setOpenScope(scope)}>安装与故障帮助</Button>
      {!oneClickAvailable && <Typography.Text type={oneClickState === 'release_gate' || oneClickState === 'check_failed' ? 'warning' : 'secondary'}>{oneClickUnavailableReason}</Typography.Text>}
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
          ? <Alert type="info" title="确认连接这台电脑" showIcon description={`将工作区 ${pairing.workspace_id} 授权给刚打开的 Store Nova 本地插件。`} />
          : oneClickAvailable
            ? <Alert type="info" title="点击连接并按浏览器提示打开本地插件" showIcon description="首次连接需确认这台电脑。若浏览器提示没有应用可打开，请先安装平台提供的桌面插件包。" />
            : <Alert type="warning" title="一键授权暂未开放" showIcon description={oneClickUnavailableReason} />}
        <Descriptions size="small" column={1} items={[
          { key: 'account', label: '当前登录账号', children: account.login },
          { key: 'workspace', label: '目标工作区', children: workspaceId ?? '请先选择当前账号已授权的工作区' },
        ]} />
        {pairing && <Button type="primary" onClick={() => { void completePairing() }}>确认连接这台电脑</Button>}
        {!oneClickAvailable && loginCommand && <Alert type="info" title="本地验证恢复路径" showIcon description={<Space orientation="vertical" size={4}>
          <Typography.Text>优先重新运行平台提供的 macOS 安装包。维护人员或旧版安装可在插件目录运行：</Typography.Text>
          <Typography.Text code copyable>{loginCommand}</Typography.Text>
          <Typography.Text type="secondary">运行前请确认商家后台登录账号为 {account.login}，授权页显示目标工作区 {workspaceId}。浏览器授权完成后，还要等待安装器确认本机凭据保存成功；然后完全退出并重新打开 ChatGPT。</Typography.Text>
        </Space>} />}
        <Typography.Paragraph style={{ margin: 0 }}>本机凭据保存成功后，完全退出并重新打开 ChatGPT。在新对话中说“检查 Store Nova 插件是否已连接”即可。</Typography.Paragraph>
      </Space>
    </Modal>
  </>
}
