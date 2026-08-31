import type { PlatformAccount } from './api'

export type MerchantConnectionTone = 'green' | 'amber'

export interface MerchantConnectionPresentation {
  status: '可读取' | '演示连接' | '需要重新授权' | '已撤销' | '仅有账号记录' | '平台暂未配置' | '连接状态待确认'
  tone: MerchantConnectionTone
  sync: '可同步' | '仅查看演示' | '需重新授权' | '不可读取' | '暂不可读取'
  canSync: boolean
  canReauthorize: boolean
}

/**
 * Keep merchant-facing connection language separate from provider state.
 * A fixture account is never presented as a writable/readable real store.
 */
export function merchantConnectionPresentation(account: Pick<PlatformAccount, 'state' | 'readEnabled'>): MerchantConnectionPresentation {
  const state = String(account.state).trim().toLowerCase()
  if (state === 'fixture_ready' || state === 'fixture') return { status: '演示连接', tone: 'amber', sync: '仅查看演示', canSync: false, canReauthorize: false }
  if (state === 'revoked') return { status: '已撤销', tone: 'amber', sync: '不可读取', canSync: false, canReauthorize: true }
  if (state === 'not_configured') return { status: '平台暂未配置', tone: 'amber', sync: '暂不可读取', canSync: false, canReauthorize: false }
  if (state === 'connected' && account.readEnabled) return { status: '可读取', tone: 'green', sync: '可同步', canSync: true, canReauthorize: false }
  if (state === 'connected') return { status: '仅有账号记录', tone: 'amber', sync: '需重新授权', canSync: false, canReauthorize: true }
  return { status: '连接状态待确认', tone: 'amber', sync: '暂不可读取', canSync: false, canReauthorize: false }
}
