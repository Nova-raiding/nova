import { useState } from 'react'
import { Alert, Button, Descriptions, Modal, Space, Typography } from 'antd'
import type { MerchantAuthAccount } from './api'

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

export function localPluginLoginCommand(apiBaseUrl: string, workspaceIds: string[]) {
  const candidateWorkspaceId = workspaceIds.length === 1 ? workspaceIds[0] : null
  const workspaceId = candidateWorkspaceId && /^(?:ws_|workspace_)[A-Za-z0-9_-]{1,120}$/u.test(candidateWorkspaceId) ? candidateWorkspaceId : null
  const apiOrigin = localLoginOrigin(apiBaseUrl)
  return workspaceId && apiOrigin
    ? `node scripts/login-local-macos.mjs --base-url ${apiOrigin} --workspace ${workspaceId}`
    : null
}

export function LocalPluginConnection({ apiBaseUrl, account }: {
  apiBaseUrl: string
  account: MerchantAuthAccount
}) {
  const [openScope, setOpenScope] = useState<string | null>(null)
  const scope = JSON.stringify([apiBaseUrl, account.id, account.login, account.status, account.workspaceIds])
  const eligible = account.accountType === 'merchant' && account.status === 'active'
  const candidateWorkspaceId = account.workspaceIds.length === 1 ? account.workspaceIds[0] : null
  const workspaceId = candidateWorkspaceId && /^(?:ws_|workspace_)[A-Za-z0-9_-]{1,120}$/u.test(candidateWorkspaceId) ? candidateWorkspaceId : null
  const command = localPluginLoginCommand(apiBaseUrl, account.workspaceIds)

  if (!eligible) return null
  return <>
    <Button onClick={() => setOpenScope(scope)}>连接本地插件</Button>
    <Modal title="连接本地插件" wrapClassName="merchant-local-plugin-modal" open={openScope === scope} onCancel={() => setOpenScope(null)} destroyOnHidden footer={
      <Button onClick={(event) => { event.stopPropagation(); setOpenScope(null) }}>关闭</Button>
    }>
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        <Alert type="info" title="请从已安装的本地插件发起登录" showIcon description="此页面只提供操作说明，不会创建、显示或保存插件凭据，也不代表插件已经安装或连接成功。" />
        <Descriptions size="small" column={1} items={[
          { key: 'account', label: '当前登录账号', children: account.login },
          { key: 'workspace', label: '目标工作区', children: workspaceId ?? '当前账号必须绑定且只能绑定一个工作区' },
          { key: 'platform', label: '支持环境', children: 'macOS 本地安装版' },
        ]} />
        {command ? <>
          <Typography.Paragraph style={{ margin: 0 }}>在你已可信安装并核验来源的 Store Nova 插件目录中运行：</Typography.Paragraph>
          <Typography.Paragraph copyable={false} style={{ margin: 0 }}><Typography.Text code>node scripts/build-keychain-helper.mjs</Typography.Text></Typography.Paragraph>
          <Typography.Paragraph copyable={false} style={{ margin: 0 }}><Typography.Text code>{command}</Typography.Text></Typography.Paragraph>
          <Typography.Paragraph style={{ margin: 0 }}>命令会通过本地 CLI 打开商家浏览器完成授权，并把凭据写入 macOS 系统钥匙串。完成后仍需重启 ChatGPT，并在新会话中调用 <Typography.Text code>onboarding.status</Typography.Text> 验证；验证通过前不要视为已连接。</Typography.Paragraph>
        </> : <Alert type="warning" showIcon title="无法生成安全的本地登录命令" description="当前 API 地址或工作区绑定未通过安全校验。请联系管理员确认 HTTPS API 地址，以及唯一且有效的工作区绑定。" />}
        <Typography.Text type="secondary">不要从此页面下载脚本，不要执行远程 curl 管道命令，也不要把 token、密码或授权地址粘贴到聊天或配置文件。</Typography.Text>
      </Space>
    </Modal>
  </>
}
