import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import type { Platform } from './types.js'

export type OutboundSecurityReason =
  | 'HTTPS_REQUIRED'
  | 'HOST_NOT_ALLOWLISTED'
  | 'PRIVATE_ADDRESS_BLOCKED'
  | 'INVALID_OUTBOUND_URL'

/**
 * Exact production hosts published by the platform adapters. An installation
 * may add an explicitly reviewed host through HttpConnectorConfig.allowedHosts;
 * wildcards are never implied by a parent domain.
 */
export const OFFICIAL_PLATFORM_HOSTS: Readonly<Record<Platform, readonly string[]>> = {
  jd: ['api.jd.com', 'router.jd.com', 'open-oauth.jd.com', 'open.jd.com'],
  taobao: ['api.taobao.com', 'eco.taobao.com', 'gw.api.taobao.com', 'oauth.taobao.com'],
  tmall: ['api.taobao.com', 'eco.taobao.com', 'gw.api.taobao.com', 'oauth.taobao.com'],
  pinduoduo: ['api.pinduoduo.com', 'open-api.pinduoduo.com', 'open.pinduoduo.com', 'jinbao.pinduoduo.com'],
  // These are only transport allowlists. Product read/write readiness still
  // requires platform-specific mapping and attributed capability evidence.
  // XHS currently documents account APIs on this host; product publishing
  // scopes remain unavailable until the platform grants and verifies them.
  xiaohongshu: ['openaccount.xiaohongshu.com'],
  // Douyin's documented OAuth/OpenAPI host. The new developer/service-provider
  // role and commerce scopes still require deployment-specific evidence.
  douyin: ['open.douyin.com', 'developer.open-douyin.com', 'partner.open-douyin.com'],
}

const blockedHostnames = new Set([
  'localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback',
  'metadata.google.internal', 'metadata.google.com', 'host.docker.internal',
])

function normalizedHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
}

function ipv4Parts(host: string): number[] | undefined {
  if (!/^\d+(?:\.\d+){3}$/.test(host)) return undefined
  const parts = host.split('.').map(Number)
  return parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : undefined
}

function isBlockedIp(host: string): boolean {
  const normalized = normalizedHost(host)
  const parts = ipv4Parts(normalized)
  if (parts) {
    const [a, b, c] = parts as [number, number, number, ...number[]]
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 0 && c === 2)
      || (a === 192 && b === 168) || (a === 198 && b >= 18 && b <= 19)
      || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)
      || a >= 224
  }
  if (isIP(normalized) !== 6) return false
  const ipv6 = normalized.replace(/^::ffff:(?:0:)?/i, '')
  if (ipv4Parts(ipv6)) return isBlockedIp(ipv6)
  return normalized === '::' || normalized === '::1'
    || normalized.startsWith('fc') || normalized.startsWith('fd')
    || normalized.startsWith('fe8') || normalized.startsWith('fe9')
    || normalized.startsWith('fea') || normalized.startsWith('feb')
}

function matchesAllowlist(host: string, allowlist: readonly string[]): boolean {
  const value = normalizedHost(host)
  return allowlist.some(entry => {
    const candidate = normalizedHost(entry)
    if (candidate.startsWith('*.')) return value.endsWith(candidate.slice(1)) && value !== candidate.slice(2)
    return value === candidate
  })
}

export interface OutboundUrlPolicy {
  environment?: string
  allowedHosts?: readonly string[]
  /** Used only for a trusted Vault endpoint explicitly allowlisted by an operator. */
  allowPrivateHosts?: boolean
  resolveDns?: boolean
}

export function isSecureEnvironment(environment = process.env.NODE_ENV): boolean {
  return environment === 'staging' || environment === 'production'
}

export function inspectOutboundUrl(raw: string, policy: OutboundUrlPolicy = {}): OutboundSecurityReason | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'INVALID_OUTBOUND_URL'
  }
  const environment = policy.environment ?? process.env.NODE_ENV
  if (isSecureEnvironment(environment) && url.protocol !== 'https:') return 'HTTPS_REQUIRED'
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'INVALID_OUTBOUND_URL'
  if (url.username || url.password || url.hash) return 'INVALID_OUTBOUND_URL'
  const host = normalizedHost(url.hostname)
  if (!host || blockedHostnames.has(host) || host.endsWith('.local') || host.endsWith('.internal')) return 'PRIVATE_ADDRESS_BLOCKED'
  if (!policy.allowPrivateHosts && isBlockedIp(host)) return 'PRIVATE_ADDRESS_BLOCKED'
  if (policy.allowedHosts && !matchesAllowlist(host, policy.allowedHosts)) return 'HOST_NOT_ALLOWLISTED'
  return undefined
}

export async function assertOutboundUrl(raw: string, policy: OutboundUrlPolicy = {}): Promise<void> {
  const reason = inspectOutboundUrl(raw, policy)
  if (reason) throw new Error(`unsafe outbound URL: ${reason}`)
  if (policy.resolveDns === false) return
  const environment = policy.environment ?? process.env.NODE_ENV
  // DNS checks are a production/staging defense. Test adapters use synthetic
  // domains and must remain deterministic without network access.
  if (!isSecureEnvironment(environment)) return
  const host = normalizedHost(new URL(raw).hostname)
  if (isIP(host)) return
  let addresses: Array<{ address: string }>
  try { addresses = await lookup(host, { all: true, verbatim: true }) } catch {
    throw new Error('unsafe outbound URL: PRIVATE_ADDRESS_BLOCKED')
  }
  if (!addresses.length || addresses.some(item => isBlockedIp(item.address))) throw new Error('unsafe outbound URL: PRIVATE_ADDRESS_BLOCKED')
}

export function officialHostsFor(platform: Platform): readonly string[] {
  return OFFICIAL_PLATFORM_HOSTS[platform]
}
