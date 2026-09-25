import { createHash, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { DomainError, type MerchantService, type Platform, type Product } from '../../../packages/application/src/service.js'
import type { OperationalAlert, OperationalAlertsRepository, OperationAudit } from '../../../packages/persistence/src/index.js'
import type { AutomationPolicy } from './mcp-automation-handlers.js'
import type { RedisAutomationLeasePort } from './redis-ports.js'
import { mapWithConcurrency } from './bounded-concurrency.js'

type JsonObject = Record<string, unknown>
type AutomationRisk = { kind: string; product_id?: string; publish_job_id?: string; platform: Platform; account_id: string | null; message: string }
type AutomationRecommendation = { id: string; kind: string; priority: 'high' | 'medium'; title: string; action: string; method: string; parameters: Record<string, string>; execution: 'read_only' | 'interactive_confirmation'; requiresInteractiveConfirmation: boolean }

export function createAutomationRuntime(dependencies: {
  service: MerchantService
  automationPolicies: Map<string, AutomationPolicy>
  alertRepository: () => OperationalAlertsRepository
  automationPolicyKey: (workspaceId: string, platform?: Platform, accountId?: string) => string
  automationWindowContains: (now: Date, start?: string, end?: string) => boolean
  nextAutomationWindowStart: (now: Date, start?: string, end?: string) => Date
  persistSnapshot: (workspaceId: string, entityType: 'automation_policy', entity: AutomationPolicy, value: Record<string, unknown>) => Promise<unknown>
  persistEvent: (workspaceId: string, aggregateId: string, eventType: string, sequence: number, payload: Record<string, unknown>) => Promise<unknown>
  persistedRuleHasBlockingRisk: (workspaceId: string, product: Product) => Promise<boolean>
  persistOperationalAlertNotification: (alert: OperationalAlert) => Promise<void>
  recordOperationAudit: (input: Omit<OperationAudit, 'id' | 'createdAt'>) => Promise<unknown>
  requestCatalogSync: (workspaceId: string, request: IncomingMessage, params: JsonObject) => Promise<unknown>
  internalAutomationTickAllowed: () => boolean
  redisAutomationLease?: RedisAutomationLeasePort
  localAutomationLeases: Map<string, { token: string; expiresAt: number }>
}) {
  const { service, automationPolicies, alertRepository, automationPolicyKey, automationWindowContains, nextAutomationWindowStart, persistSnapshot, persistEvent, persistedRuleHasBlockingRisk, persistOperationalAlertNotification, recordOperationAudit, requestCatalogSync, internalAutomationTickAllowed, redisAutomationLease, localAutomationLeases } = dependencies
  async function saveAutomationPolicy(policy: AutomationPolicy, eventType = 'automation.policy.updated') {
    policy.updatedAt = new Date().toISOString()
    automationPolicies.set(automationPolicyKey(policy.workspaceId, policy.platform, policy.accountId), policy)
    await persistSnapshot(policy.workspaceId, 'automation_policy', policy, policy as unknown as Record<string, unknown>)
    await persistEvent(policy.workspaceId, policy.id, eventType, policy.revision, { policy_id: policy.id, platform: policy.platform ?? null, account_id: policy.accountId ?? null, enabled: policy.enabled, mode: policy.mode, frequency_minutes: policy.frequencyMinutes, retry_limit: policy.retryLimit, pause_reason: policy.pauseReason ?? null })
    return policy
  }

  async function executeAutomationScan(workspaceId: string, platform?: Platform, accountId?: string) {
    const products = service.listProducts(workspaceId, { ...(platform ? { platform } : {}), ...(accountId ? { accountId } : {}) })
    const jobs = [...service.publishJobs.values()].filter(job => job.workspaceId === workspaceId && (!platform || job.platform === platform) && (!accountId || job.accountId === accountId))
    const selectedAccounts = service.listPlatformAccounts(workspaceId).filter(account => (!platform || account.platform === platform) && (!accountId || account.id === accountId))
    // Rule evaluation performs a durable read for every product. Keep this
    // bounded so one operator refresh cannot exhaust the shared tenant pool
    // when a workspace has a large catalog.
    const ruleRiskCandidates = await mapWithConcurrency(products, 4, async product => {
      const evaluation = service.ruleCenter.evaluate({ platform: product.platform, ...(product.category ? { category: product.category } : {}), ...(product.storeName ? { store: product.storeName } : {}) })
      const inMemoryBlocking = evaluation.findings.some(finding => finding.severity === 'error' && ['RULE_EXPIRED', 'RULE_NOT_YET_EFFECTIVE', 'RULE_PRIORITY_CONFLICT'].includes(finding.code))
      if (!inMemoryBlocking && !(await persistedRuleHasBlockingRisk(workspaceId, product))) return undefined
      return { kind: 'rule_conflict' as const, product_id: product.id, platform: product.platform, account_id: product.accountId ?? null, message: '适用平台规则存在过期、未生效或优先级冲突' }
    })
    const ruleRisks = ruleRiskCandidates.filter((risk): risk is NonNullable<typeof risk> => Boolean(risk))
    const risks: AutomationRisk[] = [
      ...selectedAccounts.filter(account => account.tokenState === 'revoked' || account.tokenState === 'refresh_required').map(account => ({ kind: 'authorization', platform: account.platform, account_id: account.id, message: `店铺授权状态为 ${account.tokenState}，需要重新授权` })),
      ...ruleRisks,
      ...products.filter(product => !product.factsConfirmed).map(product => ({ kind: 'unconfirmed_facts', product_id: product.id, platform: product.platform, account_id: product.accountId ?? null, message: '商品事实尚未确认' })),
      ...products.filter(product => product.stock <= 0).map(product => ({ kind: 'out_of_stock', product_id: product.id, platform: product.platform, account_id: product.accountId ?? null, message: '库存为零' })),
      ...products.filter(product => product.stock > 0 && product.stock <= 10).map(product => ({ kind: 'low_stock', product_id: product.id, platform: product.platform, account_id: product.accountId ?? null, message: `库存偏低：${product.stock}` })),
      // `reconciling` is included because delivery drift (content already live,
      // task moved on) never resolves itself and must reach an operator's queue.
      // Jobs an operator already acknowledged are excluded: they are settled, not
      // pending work, and would otherwise occupy the queue forever.
      ...jobs.filter(job => !job.operatorAcknowledgement && (['rejected', 'unknown', 'manual_attention'].includes(job.state) || job.state === 'reconciling')).map(job => ({ kind: 'publish_attention', publish_job_id: job.id, platform: job.platform, account_id: job.accountId ?? null, message: job.state === 'reconciling' ? '发布内容可能已上线但本地任务内容已漂移，需人工对账后确认' : `发布状态需要人工处理：${job.state}` })),
    ]
    const alerts = alertRepository()
    for (const risk of risks) {
      const entityId = risk.product_id ?? risk.publish_job_id ?? `${risk.kind}:${workspaceId}`
      const persisted = await alerts.upsert({ alertKey: `automation:${risk.kind}:${entityId}`, code: `AUTOMATION_${risk.kind.toUpperCase()}`, severity: risk.kind === 'publish_attention' ? 'high' : 'medium', ...(risk.platform ? { platform: risk.platform } : {}), ...(risk.account_id ? { accountId: risk.account_id } : {}), entityType: risk.product_id ? 'product' : 'publish_job', entityId, title: risk.message, observedAt: new Date().toISOString(), evidence: { kind: risk.kind, ...(risk.product_id ? { productId: risk.product_id } : {}), ...(risk.publish_job_id ? { publishJobId: risk.publish_job_id } : {}) }, nextAction: '在交互会话中查看详情，修正后再执行人工确认或重试。', workspaceId })
      void persistOperationalAlertNotification(persisted)
    }
    const recommendations: AutomationRecommendation[] = risks.map((risk, index): AutomationRecommendation => {
      const id = `automation-recommendation:${risk.kind}:${risk.product_id ?? risk.publish_job_id ?? index}`
      if (risk.kind === 'authorization') return { id, kind: risk.kind, priority: 'high', title: '恢复店铺授权', action: '打开官方授权入口并完成重新授权', method: 'platform.connect', parameters: { platform: risk.platform }, execution: 'interactive_confirmation', requiresInteractiveConfirmation: true }
      if (risk.kind === 'unconfirmed_facts') return { id, kind: risk.kind, priority: 'high', title: '确认商品事实', action: '核对价格、库存、SKU、图片和属性后确认', method: 'catalog.facts.confirm', parameters: { product_id: risk.product_id ?? '' }, execution: 'interactive_confirmation', requiresInteractiveConfirmation: true }
      if (risk.kind === 'out_of_stock' || risk.kind === 'low_stock') {
        return risk.account_id
          ? { id, kind: risk.kind, priority: risk.kind === 'out_of_stock' ? 'high' : 'medium', title: risk.kind === 'out_of_stock' ? '处理缺货商品' : '复核低库存商品', action: '同步店铺库存并由运营确认补货、下架或调整推广', method: 'catalog.sync.start', parameters: { platform: risk.platform, account_id: risk.account_id }, execution: 'interactive_confirmation', requiresInteractiveConfirmation: true }
          : { id, kind: risk.kind, priority: 'high', title: '绑定店铺后处理库存', action: '先完成店铺授权，再同步库存', method: 'platform.connect', parameters: { platform: risk.platform }, execution: 'interactive_confirmation', requiresInteractiveConfirmation: true }
      }
      if (risk.kind === 'publish_attention') return { id, kind: risk.kind, priority: 'high', title: '复核发布异常', action: '查看远端状态、差异和失败原因', method: 'publish.get', parameters: { job_id: risk.publish_job_id ?? '' }, execution: 'read_only', requiresInteractiveConfirmation: false }
      return { id, kind: risk.kind, priority: 'medium', title: '检查平台规则', action: '查看当前平台适用规则和冲突项', method: 'rule.list', parameters: { platform: risk.platform }, execution: 'read_only', requiresInteractiveConfirmation: false }
    })
    return { scannedAt: new Date().toISOString(), scope: { platform: platform ?? null, accountId: accountId ?? null }, counts: { products: products.length, publishJobs: jobs.length, risks: risks.length, alertsUpserted: risks.length }, risks, recommendations, actions: ['查看结构化优化建议', '在交互会话中确认后执行建议动作'], humanConfirmationRequired: true as const, unattendedAutoResubmit: false as const }
  }

  async function scanAutomationAfterOperationalCompletion(workspaceId: string, platform: Platform, accountId: string, trigger: string) {
    const policy = automationPolicies.get(automationPolicyKey(workspaceId, platform, accountId))
    if (!policy?.enabled) return { triggered: false as const, reason: 'automation_policy_disabled' as const }
    try {
      const scan = await executeAutomationScan(workspaceId, platform, accountId)
      await recordOperationAudit({
        workspaceId,
        actorId: 'automation-sync-hook',
        action: 'automation.post_sync_scan',
        resourceType: 'automation_policy',
        resourceId: policy.id,
        before: {},
        after: { platform, accountId, trigger, risks: scan.counts.risks, products: scan.counts.products },
        reason: '商品同步完成后按店铺策略即时执行风险扫描；不自动发布或重试',
      })
      return { triggered: true as const, ...scan }
    } catch (error) {
      return { triggered: false as const, reason: 'automation_scan_failed' as const, error: error instanceof Error ? error.message : '自动化同步后扫描失败' }
    }
  }

  async function runAutomationTickUnlocked(workspaceId: string, req: IncomingMessage, actorId: string) {
    const nowMs = Date.now(); const executed: Array<Record<string, unknown>> = []
    for (const policy of [...automationPolicies.values()].filter(item => item.workspaceId === workspaceId && item.enabled)) {
      if (policy.nextRunAt && Date.parse(policy.nextRunAt) > nowMs) continue
      const current = new Date(nowMs)
      if (!automationWindowContains(current, policy.windowStart, policy.windowEnd)) {
        const nextWindow = nextAutomationWindowStart(current, policy.windowStart, policy.windowEnd)
        policy.nextRunAt = nextWindow.toISOString()
        policy.revision += 1
        await saveAutomationPolicy(policy, 'automation.policy.deferred_window')
        await recordOperationAudit({ workspaceId, actorId, action: 'automation.policy.deferred_window', resourceType: 'automation_policy', resourceId: policy.id, before: {}, after: { nextRunAt: policy.nextRunAt, windowStart: policy.windowStart, windowEnd: policy.windowEnd }, reason: '当前时间不在店铺自动化执行窗口内' })
        executed.push({ policyId: policy.id, platform: policy.platform ?? null, accountId: policy.accountId ?? null, deferred: true, reason: 'outside_execution_window', nextRunAt: policy.nextRunAt })
        continue
      }
      const scan = await executeAutomationScan(workspaceId, policy.platform, policy.accountId)
      const blockingRisk = scan.risks.find(risk => risk.kind === 'authorization' || risk.kind === 'rule_conflict')
      if (blockingRisk) {
        const pauseReason = `自动暂停：${blockingRisk.message}`
        const before = { enabled: policy.enabled, pauseReason: policy.pauseReason ?? null, syncEnabled: policy.syncEnabled }
        policy.enabled = false
        policy.pauseReason = pauseReason
        policy.lastRunAt = scan.scannedAt
        policy.nextRunAt = undefined
        policy.revision += 1
        await saveAutomationPolicy(policy, 'automation.policy.auto_paused')
        await recordOperationAudit({ workspaceId, actorId, action: 'automation.policy.auto_paused', resourceType: 'automation_policy', resourceId: policy.id, before, after: { enabled: false, pauseReason, syncEnabled: policy.syncEnabled, risk: blockingRisk }, reason: pauseReason })
        executed.push({ policyId: policy.id, platform: policy.platform ?? null, accountId: policy.accountId ?? null, ...scan, paused: true, pauseReason, syncSkipped: true })
        continue
      }
      let sync: Record<string, unknown> | undefined
      let syncError: Record<string, unknown> | undefined
      // Claim the next execution before creating any external sync work. If the
      // process dies after the job is accepted but before the final audit write,
      // the persisted schedule still prevents an immediate duplicate tick.
      policy.lastRunAt = scan.scannedAt
      policy.nextRunAt = new Date(Date.parse(scan.scannedAt) + policy.frequencyMinutes * 60_000).toISOString()
      policy.claimedAt = scan.scannedAt
      policy.revision += 1
      await saveAutomationPolicy(policy, 'automation.policy.claimed')
      if (policy.syncEnabled && policy.platform && policy.accountId) {
        try { sync = await requestCatalogSync(workspaceId, req, { platform: policy.platform, account_id: policy.accountId }) as unknown as Record<string, unknown> }
        catch (error) { syncError = { code: error instanceof DomainError ? error.code : 'SYNC_REQUEST_FAILED', message: error instanceof Error ? error.message : '同步任务创建失败' } }
      }
      if (typeof sync?.id === 'string') policy.lastSyncJobId = sync.id
      policy.claimedAt = undefined
      await saveAutomationPolicy(policy, 'automation.policy.executed')
      await recordOperationAudit({ workspaceId, actorId, action: 'automation.tick', resourceType: 'automation_policy', resourceId: policy.id, before: {}, after: { lastRunAt: policy.lastRunAt, nextRunAt: policy.nextRunAt, risks: scan.counts.risks, syncJobId: sync?.id ?? null, syncError: syncError?.code ?? null }, reason: policy.syncEnabled ? '自动化调度器执行店铺风险扫描并请求商品同步' : '自动化调度器执行到期店铺风险扫描' })
      executed.push({ policyId: policy.id, platform: policy.platform ?? null, accountId: policy.accountId ?? null, ...scan, ...(sync ? { sync } : {}), ...(syncError ? { syncError } : {}) })
    }
    return { executedAt: new Date().toISOString(), executed, skipped: false as const, skipReason: undefined, unattendedAutoResubmit: false as const, humanConfirmationRequired: true as const }
  }

  async function runAutomationTick(workspaceId: string, req: IncomingMessage, actorId: string) {
    if (!internalAutomationTickAllowed()) {
      return {
        executedAt: new Date().toISOString(),
        executed: [],
        skipped: true as const,
        skipReason: 'codex_native_automations_only' as const,
        unattendedAutoResubmit: false as const,
        humanConfirmationRequired: true as const,
      }
    }
    const configuredTtl = Number(process.env.AUTOMATION_TICK_LEASE_MS ?? 120_000)
    const ttlMs = Number.isSafeInteger(configuredTtl) ? Math.min(10 * 60_000, Math.max(5_000, configuredTtl)) : 120_000
    const key = `merchant:automation-tick:${createHash('sha256').update(workspaceId).digest('hex')}`
    const token = randomUUID()
    let acquired = false
    if (redisAutomationLease) {
      acquired = await redisAutomationLease.acquire(key, token, ttlMs)
    } else {
      const current = localAutomationLeases.get(key)
      if (!current || current.expiresAt <= Date.now()) {
        localAutomationLeases.set(key, { token, expiresAt: Date.now() + ttlMs })
        acquired = true
      }
    }
    if (!acquired) return { executedAt: new Date().toISOString(), executed: [], skipped: true as const, skipReason: 'automation_tick_lease_held', unattendedAutoResubmit: false as const, humanConfirmationRequired: true as const }
    const renewLease = async () => {
      if (redisAutomationLease) {
        await redisAutomationLease.renew(key, token, ttlMs)
        return
      }
      const current = localAutomationLeases.get(key)
      if (current?.token === token) current.expiresAt = Date.now() + ttlMs
    }
    const heartbeat = setInterval(() => { void renewLease().catch(() => undefined) }, Math.max(1_000, Math.floor(ttlMs / 3)))
    try {
      const testDelayMs = process.env.NODE_ENV === 'test' ? Number(process.env.AUTOMATION_TICK_LEASE_TEST_DELAY_MS ?? 0) : 0
      if (Number.isSafeInteger(testDelayMs) && testDelayMs > 0) await new Promise(resolve => setTimeout(resolve, Math.min(testDelayMs, 1_000)))
      return await runAutomationTickUnlocked(workspaceId, req, actorId)
    } finally {
      clearInterval(heartbeat)
      if (redisAutomationLease) await redisAutomationLease.release(key, token)
      else if (localAutomationLeases.get(key)?.token === token) localAutomationLeases.delete(key)
    }
  }

  async function reconcileAutomationClaims(workspaceId: string) {
    const policies = [...automationPolicies.values()].filter(policy => policy.workspaceId === workspaceId && policy.enabled && policy.claimedAt)
    for (const policy of policies) {
      const claimedAtMs = Date.parse(policy.claimedAt!)
      const matching = policy.syncEnabled && Number.isFinite(claimedAtMs)
        ? service.listSyncJobs(workspaceId).filter(job => (!policy.platform || job.platform === policy.platform) && (!policy.accountId || job.accountId === policy.accountId)).filter(job => {
          const createdAtMs = Date.parse(job.createdAt)
          return Number.isFinite(createdAtMs) && createdAtMs >= claimedAtMs - 5_000
        }).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
        : undefined
      const recovered = structuredClone(policy)
      recovered.claimedAt = undefined
      if (matching) recovered.lastSyncJobId = matching.id
      else if (policy.syncEnabled) recovered.nextRunAt = new Date().toISOString()
      recovered.revision += 1
      await saveAutomationPolicy(recovered, matching ? 'automation.policy.claim.recovered' : 'automation.policy.claim.requeued')
    }
  }

  return { saveAutomationPolicy, executeAutomationScan, scanAutomationAfterOperationalCompletion, runAutomationTick, reconcileAutomationClaims }
}
