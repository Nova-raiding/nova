import { assertOutboundUrl, inspectOutboundUrl, isSecureEnvironment } from '../../connectors/src/outbound-security.js'

export interface RelaySecurityPolicy {
  environment?: string
  allowedHosts?: readonly string[]
}

export function relaySecurityFromEnv(source: Record<string, string | undefined>): RelaySecurityPolicy | undefined {
  const environment = source.NODE_ENV
  if (!/^https:\/\//u.test(source.MODEL_RELAY_BASE_URL?.trim() ?? '')) return undefined
  const allowedHosts = (source.MODEL_RELAY_ALLOWED_HOSTS ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
  if (isSecureEnvironment(environment) && !allowedHosts.length) return undefined
  const reason = inspectOutboundUrl(source.MODEL_RELAY_BASE_URL ?? '', { environment, ...(allowedHosts.length ? { allowedHosts } : {}), resolveDns: false })
  if (reason) return undefined
  return { environment, ...(allowedHosts.length ? { allowedHosts } : {}) }
}

export async function assertRelayUrl(baseUrl: string, policy: RelaySecurityPolicy): Promise<void> {
  // Directly constructed adapters are used by deterministic unit tests and by
  // trusted in-process callers; environment-created production adapters always
  // carry an explicit environment/allowlist policy.
  if (!policy.environment && !policy.allowedHosts?.length) {
    await assertOutboundUrl(baseUrl, { environment: 'test', resolveDns: false })
    return
  }
  // RFC 2606 test domains are used by deterministic provider fixtures; they
  // are never routable production relay names and must not make unit tests
  // depend on external DNS.
  if (new URL(baseUrl).hostname.toLowerCase().endsWith('.test')) {
    await assertOutboundUrl(baseUrl, { environment: policy.environment, ...(policy.allowedHosts ? { allowedHosts: policy.allowedHosts } : {}), resolveDns: false })
    return
  }
  await assertOutboundUrl(baseUrl, { environment: policy.environment, ...(policy.allowedHosts ? { allowedHosts: policy.allowedHosts } : {}), resolveDns: true })
}
