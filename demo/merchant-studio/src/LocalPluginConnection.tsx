import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Descriptions, Modal, Space, Typography } from 'antd'
import type { MerchantAuthAccount } from './api'
import { LocalPluginConnectionError, requestLocalPluginCredential } from './local-plugin-connection'

type CredentialStatus = Awaited<ReturnType<typeof requestLocalPluginCredential>>
type ConnectionState =
  | { scope: string; status: 'requesting' }
  | { scope: string; status: 'installer_required'; result: CredentialStatus }
  | { scope: string; status: 'error'; message: string }

export function LocalPluginConnection({ apiBaseUrl, account }: {
  apiBaseUrl: string
  account: MerchantAuthAccount
}) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<ConnectionState | null>(null)
  const request = useRef<AbortController | null>(null)
  const scope = JSON.stringify([apiBaseUrl, account.id, account.login, account.status, account.workspaceIds])
  const latestScope = useRef(scope)
  latestScope.current = scope
  const current = state?.scope === scope ? state : null
  const eligible = account.accountType === 'merchant' && account.status === 'active'

  useEffect(() => {
    return () => { request.current?.abort(); request.current = null }
  }, [scope])

  const close = () => {
    request.current?.abort()
    request.current = null
    setOpen(false)
    setState(null)
  }
  const connect = async () => {
    if (!eligible || request.current) return
    const controller = new AbortController()
    request.current = controller
    setOpen(true)
    setState({ scope, status: 'requesting' })
    try {
      const result = await requestLocalPluginCredential(apiBaseUrl, account, controller.signal)
      if (controller.signal.aborted || request.current !== controller || latestScope.current !== scope) return
      setState({ scope, status: 'installer_required', result })
    } catch (cause) {
      if (controller.signal.aborted || request.current !== controller || latestScope.current !== scope) return
      setState({ scope, status: 'error', message: cause instanceof LocalPluginConnectionError ? cause.message : '连接验证未完成，请检查网络后重试。' })
    } finally {
      if (request.current === controller) request.current = null
    }
  }

  if (!eligible) return null
  return <>
    <Button onClick={() => void connect()}>连接本地插件</Button>
    <Modal title="连接本地插件" open={open && state?.scope === scope} onCancel={close} destroyOnHidden footer={
      <Space>
        {current?.status === 'error' && <Button type="primary" onClick={() => void connect()}>重试验证</Button>}
        <Button onClick={close}>{current?.status === 'requesting' ? '取消' : '关闭'}</Button>
      </Space>
    }>
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        <Typography.Paragraph style={{ margin: 0 }}>仅为当前登录账号和工作区申请短期插件凭据，不修改生产鉴权或店铺授权。</Typography.Paragraph>
        <Descriptions size="small" column={1} items={[
          { key: 'account', label: '登录账号', children: account.login },
          { key: 'workspace', label: '工作区', children: current?.status === 'installer_required' ? current.result.workspaceId : account.workspaceIds.length === 1 ? account.workspaceIds[0] : '需要绑定唯一工作区' },
          { key: 'credential', label: '凭据状态', children: current?.status === 'requesting' ? '正在验证…' : current?.status === 'installer_required' ? '已签发，未安装' : '未确认' },
        ]} />
        {current?.status === 'requesting' && <div role="status" aria-live="polite" aria-busy="true">正在通过当前登录会话验证连接凭据，可取消。</div>}
        {current?.status === 'error' && <div role="alert"><Alert type="error" title="连接验证未完成" description={current.message} showIcon /></div>}
        {current?.status === 'installer_required' && <div role="status" aria-live="polite">
          <Alert type="warning" title="待安装器接管 · 本地插件尚未连接" showIcon description={
            <Space orientation="vertical" size="small">
              <span>浏览器不能安全写入系统钥匙串，当前也未接入可信安装器交接通道。本次临时凭据已丢弃，未写入浏览器存储。</span>
              <span>请使用平台提供的可信本地安装器完成登录和系统凭据保存；没有安装器时请联系平台获取，不要复制密码或凭据到聊天、配置文件。</span>
              <span>安装器需要重新申请凭据。完成安装并通过插件状态核验前，不代表已连接或可调用模型。</span>
            </Space>
          } />
        </div>}
        <Typography.Text type="secondary">凭据不会在页面显示、下载或写入 localStorage。</Typography.Text>
      </Space>
    </Modal>
  </>
}
