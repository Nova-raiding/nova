import { randomUUID } from 'node:crypto'
import { DomainError } from '../../../packages/application/src/service.js'
import {
  AUTHZ_POLICY_VERSION,
  CAPABILITIES,
  MCP_METHODS,
  capabilitiesForRoles,
  evaluatePermissionAtoms,
  getMcpMethodPolicy,
  type AuthorizationDecisionMode,
  type AuthorizationObligation,
  type CanonicalRole,
  type PermissionAtom,
  type OpsWorkbench,
} from '../../../packages/contracts/src/index.js'
import { authorizationPolicyUnavailableDetails } from './authorization-projection-helpers.js'

const alwaysEnforcedMcpMethods = new Set([
  'ops.user.suspend', 'ops.user.activate', 'ops.user.risk.transition', 'ops.user.session.revoke',
  'ops.member.upsert', 'ops.member.suspend', 'ops.feature-flag.upsert', 'ops.feature-flag.emergency.set',
  'ops.data.delete.cancel', 'ops.data.delete.approve', 'workspace.data.delete.request', 'billing.usage.refund', 'billing.refund',
  'rule.publish', 'publish.confirm', 'publish.batch.confirm', 'catalog.image.select', 'automation.policy.update', 'automation.pause',
  'brand.upsert', 'ops.marketing.asset_scan.retry', 'ops.platform.store.record.create',
])
const knownAuthorizationDomains = new Set(CAPABILITIES.map(capability => capability.split('.')[0]!))

export function productionAuthorizationReadiness(source: NodeJS.ProcessEnv = process.env, production = source.NODE_ENV === 'production') {
  if (!production) return { ready: true, reasons: [] as string[] }
  const reasons: string[] = []
  if (source.MCP_AUTHZ_MODE !== 'enforce') reasons.push('mcp_authz_mode_not_enforce')
  if (source.AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED !== 'true') reasons.push('durable_assignments_not_required')
  if (source.MCP_AUTHZ_ENFORCE_DOMAINS?.trim()) reasons.push('enforce_domains_must_be_empty')
  let coverage: ReturnType<typeof mcpAuthorizationCoverageReport> | { mode: string; available: false }
  try { coverage = mcpAuthorizationCoverageReport(source, false, false) }
  catch { coverage = { mode: source.MCP_AUTHZ_MODE?.trim() || 'unset', available: false } }
  return { ready: reasons.length === 0, reasons, coverage }
}

export function assertProductionAuthorizationRuntime(source: NodeJS.ProcessEnv = process.env, production = source.NODE_ENV === 'production', testRuntime = source.VITEST === 'true') {
  if (!production || testRuntime) return
  if (!productionAuthorizationReadiness(source, true).ready) throw new DomainError('AUTHORIZATION_RUNTIME_NOT_READY', '生产授权运行时未满足全量强制执行和持久角色权威要求', 503)
}

export function mcpAuthorizationRuntimeConfig(source: NodeJS.ProcessEnv = process.env, production = source.NODE_ENV === 'production', testRuntime = source.VITEST === 'true') {
  assertProductionAuthorizationRuntime(source, production, testRuntime)
  const rawMode = source.MCP_AUTHZ_MODE?.trim()
  if (!rawMode) return { mode: 'shadow' as const, enforceDomains: new Set<string>() }
  if (rawMode !== 'shadow' && rawMode !== 'staged' && rawMode !== 'enforce') throw new DomainError('AUTHZ_MODE_INVALID', 'MCP_AUTHZ_MODE 仅支持 shadow、staged 或 enforce，未知模式已拒绝启动授权', 503)
  const rawDomains = (source.MCP_AUTHZ_ENFORCE_DOMAINS ?? '').split(',').map(value => value.trim()).filter(Boolean)
  if (rawMode === 'shadow' && rawDomains.length) throw new DomainError('AUTHZ_ENFORCE_DOMAINS_INVALID', 'shadow 模式不能声明强制域，避免产生已强制的错误预期', 503)
  if (rawMode === 'enforce' && rawDomains.length) throw new DomainError('AUTHZ_ENFORCE_DOMAINS_INVALID', 'enforce 模式已经覆盖全部 capability 域，不应再声明分阶段域', 503)
  if (rawMode === 'staged' && rawDomains.length === 0) throw new DomainError('AUTHZ_ENFORCE_DOMAINS_REQUIRED', 'staged 模式必须显式声明至少一个 capability 域', 503)
  const invalid = rawDomains.filter(domain => !knownAuthorizationDomains.has(domain))
  if (invalid.length) throw new DomainError('AUTHZ_ENFORCE_DOMAIN_UNKNOWN', `未知 capability 域: ${invalid.join(',')}`, 503)
  return { mode: rawMode, enforceDomains: new Set(rawDomains) }
}

export function mcpAuthorizationEnforcedMethods(source: NodeJS.ProcessEnv = process.env, production = source.NODE_ENV === 'production', testRuntime = source.VITEST === 'true') {
  const runtime = mcpAuthorizationRuntimeConfig(source, production, testRuntime)
  return MCP_METHODS.filter(method => {
    const policy = getMcpMethodPolicy(method)!
    return runtime.mode === 'enforce' || alwaysEnforcedMcpMethods.has(method) || runtime.enforceDomains.has(policy.capability.split('.')[0]!)
  })
}

export function mcpAuthorizationCoverageReport(source: NodeJS.ProcessEnv = process.env, production = source.NODE_ENV === 'production', testRuntime = source.VITEST === 'true') {
  const runtime = mcpAuthorizationRuntimeConfig(source, production, testRuntime)
  const enforcedMethods = new Set(mcpAuthorizationEnforcedMethods(source, production, testRuntime))
  const domains = [...knownAuthorizationDomains].sort()
  const enforcedDomains = domains.filter(domain => MCP_METHODS.filter(method => getMcpMethodPolicy(method)!.capability.split('.')[0] === domain).every(method => enforcedMethods.has(method)))
  return Object.freeze({ mode: runtime.mode, policy_version: AUTHZ_POLICY_VERSION, method_total: MCP_METHODS.length, enforced_method_count: enforcedMethods.size, shadow_method_count: MCP_METHODS.length - enforcedMethods.size, enforcement_ratio: enforcedMethods.size / MCP_METHODS.length, domain_total: domains.length, enforced_domains: enforcedDomains, shadow_domains: domains.filter(domain => !enforcedDomains.includes(domain)) })
}

export function registeredMcpAuthorizationDecision(input: {
  decisionId: string; method: string; policy?: NonNullable<ReturnType<typeof getMcpMethodPolicy>>; atoms: readonly PermissionAtom[]
  satisfiedObligations?: readonly AuthorizationObligation[]; resourceScope?: Parameters<typeof evaluatePermissionAtoms>[0]['resourceScope']
  workbench: OpsWorkbench; mode: AuthorizationDecisionMode; now?: string
}) {
  const policy = input.policy ?? getMcpMethodPolicy(input.method)
  if (!policy) throw new DomainError('AUTHZ_POLICY_UNAVAILABLE', '当前方法缺少服务端授权策略，已拒绝执行', 503, authorizationPolicyUnavailableDetails({ transport: 'mcp', method: input.method }))
  return evaluatePermissionAtoms({ decisionId: input.decisionId, policy, atoms: input.atoms, satisfiedObligations: input.satisfiedObligations, resourceScope: input.resourceScope, workbench: input.workbench, mode: input.mode, now: input.now })
}

export function merchantEntryBillingReadAllowed(input: { atoms: readonly PermissionAtom[]; workspaceId: string; workbench: OpsWorkbench }) {
  return registeredMcpAuthorizationDecision({ decisionId: `authz_${randomUUID()}`, method: 'creative-points.balance.get', atoms: input.atoms.filter(atom => atom.effect === 'deny' || atom.source !== 'temporary_grant'), resourceScope: { type: 'workspace', id: input.workspaceId }, workbench: input.workbench, mode: 'enforce' }).authorized
}

export function httpAuthorizationPathParams(pathTemplate: string, pathname: string, mcpMethod: string): Record<string, string> {
  const templateSegments = pathTemplate.split('/').filter(Boolean)
  const pathSegments = pathname.split('/').filter(Boolean)
  if (templateSegments.length !== pathSegments.length) return {}
  const params: Record<string, string> = {}
  for (let index = 0; index < templateSegments.length; index += 1) {
    const placeholder = /^\{([A-Za-z][A-Za-z0-9]*)\}$/u.exec(templateSegments[index]!)
    if (!placeholder) continue
    const name = placeholder[1]!
    const snakeName = name === 'jobId' ? (mcpMethod.startsWith('publish.') ? 'publish_job_id' : 'job_id') : name.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase()
    params[snakeName] = decodeURIComponent(pathSegments[index]!)
  }
  return params
}
