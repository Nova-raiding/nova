import { createHash, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { DomainError, type Platform } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import type { OperationAudit } from '../../../packages/persistence/src/index.js'

export type AutomationPolicy = { workspaceId: string; id: string; platform?: Platform; accountId?: string; enabled: boolean; mode: 'scan_alert_manual_retry' | 'scan_sync_alert_manual_retry'; syncEnabled: boolean; frequencyMinutes: number; retryLimit: number; windowStart?: string; windowEnd?: string; pauseReason?: string; lastRunAt?: string; nextRunAt?: string; claimedAt?: string; lastSyncJobId?: string; revision: number; updatedAt: string }

export const MCP_AUTOMATION_METHODS = new Set([
  'automation.policy.get',
  'automation.policy.list',
  'automation.policy.update',
  'automation.scan',
  'automation.tick',
  'automation.pause',
])

interface AutomationMcpDependencies {
  policies: Map<string, AutomationPolicy>
  validateScope: (workspaceId: string, platform?: Platform, accountId?: string) => unknown
  policyKey: (workspaceId: string, platform?: Platform, accountId?: string) => string
  normalizeTime: (value: string | undefined, field: string) => string | undefined
  savePolicy: (policy: AutomationPolicy, eventType?: string) => Promise<unknown>
  executeScan: (workspaceId: string, platform?: Platform, accountId?: string) => Promise<unknown>
  runTick: (workspaceId: string, req: IncomingMessage, actorId: string) => Promise<unknown>
  workspaceStoreDirectory: typeof import('./server.js').workspaceStoreDirectory
  listWorkspaceIds?: () => Promise<string[]>
  isPlatformOperations: (req: IncomingMessage) => boolean
  requireOperationsRole: (req: IncomingMessage, allowed: readonly string[]) => string
  requiresStrictAuth: () => boolean
  actorIdForRequest: (req: IncomingMessage) => string
  required: (params: Record<string, unknown>, key: string) => string
  recordOperationAudit: (audit: Omit<OperationAudit, 'id' | 'createdAt'>) => Promise<unknown>
}

export async function handleMcpAutomationMethod(
  method: string,
  params: Record<string, unknown>,
  req: IncomingMessage,
  workspaceId: string,
  deps: AutomationMcpDependencies,
): Promise<unknown> {
  const {
    validateScope: validateAutomationScope, policyKey: automationPolicyKey,
    normalizeTime: normalizeAutomationTime, savePolicy: saveAutomationPolicy,
    executeScan: executeAutomationScan, runTick: runAutomationTick,
    workspaceStoreDirectory, isPlatformOperations, requireOperationsRole,
    requiresStrictAuth, required, recordOperationAudit,
  } = deps
  const automationPolicies = deps.policies
  const result = (value: unknown) => value
  switch (method) {
    case 'automation.policy.get': {
      const platform = typeof params.platform === 'string' ? params.platform as Platform : undefined
      const accountId = typeof params.account_id === 'string' && params.account_id.trim() ? params.account_id.trim() : undefined
      validateAutomationScope(workspaceId, platform, accountId)
      const key = automationPolicyKey(workspaceId, platform, accountId)
      const policy = automationPolicies.get(key) ?? { workspaceId, id: `automation_${createHash('sha1').update(key).digest('hex').slice(0, 16)}`, ...(platform ? { platform } : {}), ...(accountId ? { accountId } : {}), enabled: false, mode: 'scan_alert_manual_retry' as const, syncEnabled: false, frequencyMinutes: 60, retryLimit: 2, revision: 1, updatedAt: new Date().toISOString(), pauseReason: '默认关闭，需商家明确开启' }
      return result({ policy, unattendedAutoResubmit: false, humanConfirmationRequired: true })
    }
    case 'automation.policy.list': {
      const platformScope = params.platform_scope === 'platform'
      if (params.platform_scope !== undefined && !platformScope) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'platform_scope 必须是 platform', 400)
      if (platformScope && !isPlatformOperations(req)) throw new DomainError(ERROR_CODES.FORBIDDEN, '只有平台运营角色可以读取平台自动化策略', 403)
      const targetWorkspaceIds = platformScope && deps.listWorkspaceIds ? await deps.listWorkspaceIds() : [workspaceId]
      const policies = [...automationPolicies.values()]
        .filter(policy => targetWorkspaceIds.includes(policy.workspaceId))
        .sort((left, right) => `${left.platform ?? ''}:${left.accountId ?? ''}`.localeCompare(`${right.platform ?? ''}:${right.accountId ?? ''}`))
      const stores = new Map(targetWorkspaceIds.flatMap(id => workspaceStoreDirectory(id).map(store => [`${id}:${store.platform}:${store.accountId}`, store] as const)))
      if (platformScope) {
        const groups = new Map<string, { platform?: Platform; enabled: boolean; mode: AutomationPolicy['mode']; syncEnabled: boolean; frequencyMinutes: number; retryLimit: number; count: number; latestUpdatedAt: string }>()
        for (const policy of policies) {
          const key = [policy.platform ?? 'workspace', policy.enabled, policy.mode, policy.syncEnabled, policy.frequencyMinutes, policy.retryLimit].join(':')
          const current = groups.get(key)
          if (current) { current.count += 1; if (policy.updatedAt > current.latestUpdatedAt) current.latestUpdatedAt = policy.updatedAt }
          else groups.set(key, { ...(policy.platform ? { platform: policy.platform } : {}), enabled: policy.enabled, mode: policy.mode, syncEnabled: policy.syncEnabled, frequencyMinutes: policy.frequencyMinutes, retryLimit: policy.retryLimit, count: 1, latestUpdatedAt: policy.updatedAt })
        }
        const aggregatePolicies = [...groups.values()].sort((left, right) => right.latestUpdatedAt.localeCompare(left.latestUpdatedAt)).map((group, index) => ({ id: `platform-automation-group-${index + 1}`, ...(group.platform ? { platform: group.platform } : {}), accountId: `platform-aggregate:${index + 1}`, enabled: group.enabled, mode: group.mode, syncEnabled: group.syncEnabled, frequencyMinutes: group.frequencyMinutes, retryLimit: group.retryLimit, revision: 0, updatedAt: group.latestUpdatedAt, aggregate: true, count: group.count, store: null }))
        return result({ policies: aggregatePolicies, count: aggregatePolicies.length, scope: 'platform', workspaceCount: targetWorkspaceIds.length, aggregate: true, unattendedAutoResubmit: false, humanConfirmationRequired: true })
      }
      return result({
        policies: policies.map(policy => ({
          ...policy,
          store: policy.platform && policy.accountId ? stores.get(`${policy.workspaceId}:${policy.platform}:${policy.accountId}`) ?? null : null,
          unattendedAutoResubmit: false,
          humanConfirmationRequired: true,
        })),
        count: policies.length,
        ...(platformScope ? { scope: 'platform', workspaceCount: targetWorkspaceIds.length } : {}),
        unattendedAutoResubmit: false,
        humanConfirmationRequired: true,
      })
    }
    case 'automation.policy.update': {
      const platform = typeof params.platform === 'string' ? params.platform as Platform : undefined
      const accountId = typeof params.account_id === 'string' && params.account_id.trim() ? params.account_id.trim() : undefined
      validateAutomationScope(workspaceId, platform, accountId)
      const key = automationPolicyKey(workspaceId, platform, accountId)
      const previous = automationPolicies.get(key)
      const enabled = required(params, 'enabled') === 'true'
      const frequencyMinutes = typeof params.frequency_minutes === 'string' && /^\d+$/u.test(params.frequency_minutes) ? Math.min(1440, Math.max(5, Number(params.frequency_minutes))) : previous?.frequencyMinutes ?? 60
      const retryLimit = typeof params.retry_limit === 'string' && /^\d+$/u.test(params.retry_limit) ? Math.min(5, Math.max(0, Number(params.retry_limit))) : previous?.retryLimit ?? 2
      const syncEnabled = params.sync_enabled === 'true' ? true : params.sync_enabled === 'false' ? false : previous?.syncEnabled ?? false
      if (syncEnabled && (!platform || !accountId)) throw new DomainError('AUTOMATION_SYNC_SCOPE_REQUIRED', '自动同步必须绑定一个明确的平台店铺，不能对工作区内所有店铺隐式执行', 400)
      const clearWindow = params.clear_window === 'true'
      const hasWindowStart = Object.prototype.hasOwnProperty.call(params, 'window_start')
      const hasWindowEnd = Object.prototype.hasOwnProperty.call(params, 'window_end')
      const windowStart = clearWindow ? undefined : hasWindowStart
        ? (typeof params.window_start === 'string' && params.window_start.trim() ? normalizeAutomationTime(params.window_start, 'window_start') : undefined)
        : previous?.windowStart
      const windowEnd = clearWindow ? undefined : hasWindowEnd
        ? (typeof params.window_end === 'string' && params.window_end.trim() ? normalizeAutomationTime(params.window_end, 'window_end') : undefined)
        : previous?.windowEnd
      if (Boolean(windowStart) !== Boolean(windowEnd)) throw new DomainError('AUTOMATION_WINDOW_INVALID', 'window_start 和 window_end 必须同时提供', 400)
      const actorId = deps.actorIdForRequest(req)
      if (requiresStrictAuth()) requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'platform_ops'])
      const policy: AutomationPolicy = { workspaceId, id: previous?.id ?? `automation_${randomUUID()}`, ...(platform ? { platform } : {}), ...(accountId ? { accountId } : {}), enabled, mode: syncEnabled ? 'scan_sync_alert_manual_retry' : 'scan_alert_manual_retry', syncEnabled, frequencyMinutes, retryLimit, ...(windowStart ? { windowStart } : {}), ...(windowEnd ? { windowEnd } : {}), ...(previous?.lastRunAt ? { lastRunAt: previous.lastRunAt } : {}), ...(enabled ? { nextRunAt: previous?.nextRunAt ?? new Date().toISOString() } : { pauseReason: required(params, 'reason') }), revision: (previous?.revision ?? 0) + 1, updatedAt: new Date().toISOString() }
      await saveAutomationPolicy(policy)
      await recordOperationAudit({ workspaceId, actorId, action: 'automation.policy.update', resourceType: 'automation_policy', resourceId: policy.id, before: previous ?? {}, after: policy as unknown as Record<string, unknown>, reason: required(params, 'reason') })
      return result({ policy, unattendedAutoResubmit: false, humanConfirmationRequired: true })
    }
    case 'automation.scan': {
      const platform = typeof params.platform === 'string' ? params.platform as Platform : undefined
      const accountId = typeof params.account_id === 'string' && params.account_id.trim() ? params.account_id.trim() : undefined
      validateAutomationScope(workspaceId, platform, accountId)
      return result(await executeAutomationScan(workspaceId, platform, accountId))
    }
    case 'automation.tick': {
      const actorId = requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'platform_ops'])
      return result(await runAutomationTick(workspaceId, req, actorId))
    }
    case 'automation.pause': {
      const reason = required(params, 'reason')
      const platform = typeof params.platform === 'string' ? params.platform as Platform : undefined
      const accountId = typeof params.account_id === 'string' && params.account_id.trim() ? params.account_id.trim() : undefined
      validateAutomationScope(workspaceId, platform, accountId)
      const actorId = deps.actorIdForRequest(req)
      if (requiresStrictAuth()) requireOperationsRole(req, ['workspace_owner', 'merchant_admin', 'operator', 'platform_ops'])
      const key = automationPolicyKey(workspaceId, platform, accountId)
      const previous = automationPolicies.get(key)
      const policy: AutomationPolicy = { workspaceId, id: previous?.id ?? `automation_${randomUUID()}`, ...(platform ? { platform } : {}), ...(accountId ? { accountId } : {}), enabled: false, mode: previous?.mode ?? 'scan_alert_manual_retry', syncEnabled: previous?.syncEnabled ?? false, frequencyMinutes: previous?.frequencyMinutes ?? 60, retryLimit: previous?.retryLimit ?? 2, ...(previous?.windowStart ? { windowStart: previous.windowStart } : {}), ...(previous?.windowEnd ? { windowEnd: previous.windowEnd } : {}), pauseReason: reason, revision: (previous?.revision ?? 0) + 1, updatedAt: new Date().toISOString() }
      await saveAutomationPolicy(policy, 'automation.policy.paused')
      await recordOperationAudit({ workspaceId, actorId, action: 'automation.policy.pause', resourceType: 'automation_policy', resourceId: policy.id, before: previous ?? {}, after: policy as unknown as Record<string, unknown>, reason })
      return result({ policy, paused: true, reason, unattendedAutoResubmit: false })
    }
    default: throw new DomainError(ERROR_CODES.INVALID_REQUEST, `未知自动化方法: ${method}`, 400)
  }
}
