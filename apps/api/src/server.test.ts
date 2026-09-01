import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { appendProtectedProductConstraints, batchStateFromItems, buildBoundedKnowledgeGenerationContext, canonicalConflictResolutionCheck, canonicalConflictScanItems, canonicalConsistencyApiReport, compareProviderUsageRecords, csvCell, customerDataMethodForHttp, executionContract, featureFlagRequestsCanonicalRead, imageGenerationReconciliationIdempotencyKey, internalAutomationTickAllowed, isPlatformScopeMethod, KNOWLEDGE_CONTEXT_LIMITS, persistAssetSnapshotAndEvent, readWorkspaceStatusInTransaction, releaseStorageQuotaAfterConfirmedDeletion, service, shouldHydrateKnowledgeForMethod, taskContextLinkId, timelineEvent, validateCustomerDataAccessGrant, workerAuthorizationDecisionMatches, workspaceStoreDirectory } from './server.js'
import { resolveCanonicalProductReadScope } from '../../../packages/application/src/canonical-product-consistency.js'
import type { AuthorizationDecision } from '../../../packages/contracts/src/index.js'
import type { SqlPool } from '../../../packages/persistence/src/index.js'
import { imageReconciliationIdempotencyKey as workerImageReconciliationIdempotencyKey } from '../../../apps/worker/src/main.js'

describe('canonical read rollout safety', () => {
  it('detects only canonical_read rollout requests', () => {
    expect(featureFlagRequestsCanonicalRead({ key: 'other.flag', defaultValue: { value: 'canonical_read' } })).toBe(false)
    expect(featureFlagRequestsCanonicalRead({ key: 'canonical.product.read_mode', defaultValue: { value: 'legacy_shadow' }, targets: [{ override: { value: 'canonical_read' } }] })).toBe(true)
    expect(featureFlagRequestsCanonicalRead({ key: 'canonical.product.read_mode', defaultValue: { value: 'dual_verify' } })).toBe(false)
    expect(featureFlagRequestsCanonicalRead({ key: 'canonical.product.read_mode', defaultValue: { value: 'legacy_shadow' }, targets: 'not-an-array' as unknown as Array<{ override?: { value?: unknown } }> })).toBe(false)
  })
})

describe('provider usage reconciliation', () => {
  it('does not collapse duplicate local requests and compares tokens per request', () => {
    const result = compareProviderUsageRecords(
      [{ providerRequestId: 'r1', inputTokens: 1, outputTokens: 2, totalTokens: 3 }, { providerRequestId: 'r1', inputTokens: 9, outputTokens: 9, totalTokens: 18 }, { providerRequestId: 'r2', inputTokens: 4, outputTokens: 1, totalTokens: 5 }],
      [{ providerRecordId: 'r1', inputTokens: 1, outputTokens: 2, totalTokens: 3 }, { providerRecordId: 'r2', inputTokens: 5, outputTokens: 1, totalTokens: 6 }],
    )
    expect(result).toMatchObject({ unmatchedLocal: 0, unmatchedProvider: 0, duplicateLocalCount: 1, tokenMismatchCount: 1, matchedRecordCount: 2 })
  })

  it('blocks reconciliation when the provider statement repeats a request id', () => {
    const result = compareProviderUsageRecords(
      [{ providerRequestId: 'r1', inputTokens: 1, outputTokens: 2, totalTokens: 3 }],
      [{ providerRecordId: 'r1', inputTokens: 1, outputTokens: 2, totalTokens: 3 }, { providerRecordId: 'r1', inputTokens: 1, outputTokens: 2, totalTokens: 3 }],
    )
    expect(result).toMatchObject({ unmatchedLocal: 0, unmatchedProvider: 0, duplicateProviderCount: 1, tokenMismatchCount: 0, matchedRecordCount: 1 })
  })
})

describe('worker authorization snapshot eligibility', () => {
  const decision = (overrides: Partial<AuthorizationDecision> = {}): AuthorizationDecision => ({
    decision_id: 'authz_1', policy_version: '2026-08-31.v2', method: 'content.generate', capability: 'customer.content.update', workbench: 'workspace',
    scope: { required: 'workspace', resource_id: 'ws_a', resolved: [{ type: 'workspace', ids: ['ws_a'] }] }, mode: 'enforce', enforced: true,
    authorized: true, allowed: true, result: 'allow', reason_code: 'AUTHZ_ALLOWED', explicit_deny: false,
    obligations: { required: [], satisfied: [], missing: [] }, ...overrides,
  })

  it('accepts only an enforced allow bound to the exact workspace and worker capability', () => {
    expect(workerAuthorizationDecisionMatches(decision(), 'ws_a', 'customer.content.update')).toBe(true)
    expect(workerAuthorizationDecisionMatches(decision({ enforced: false, mode: 'shadow', result: 'shadow_allow' }), 'ws_a', 'customer.content.update')).toBe(true)
    expect(workerAuthorizationDecisionMatches(decision({ authorized: false, allowed: true, enforced: false, mode: 'shadow', result: 'shadow_deny', reason_code: 'AUTHZ_CAPABILITY_MISSING' }), 'ws_a', 'customer.content.update')).toBe(false)
    expect(workerAuthorizationDecisionMatches(decision({ capability: 'customer.publish.execute' }), 'ws_a', 'customer.content.update')).toBe(false)
    expect(workerAuthorizationDecisionMatches(decision({ scope: { required: 'workspace', resource_id: 'ws_b', resolved: [{ type: 'workspace', ids: ['ws_b'] }] } }), 'ws_a', 'customer.content.update')).toBe(false)
    expect(workerAuthorizationDecisionMatches(decision({ workbench: 'platform' }), 'ws_a', 'customer.content.update')).toBe(false)
  })

})

describe('CSV export safety', () => {
  it('neutralizes spreadsheet formula prefixes while preserving CSV quoting', () => {
    expect(csvCell('=HYPERLINK("https://evil.example")')).toBe(`"'=HYPERLINK(""https://evil.example"")"`)
    expect(csvCell('normal, text')).toBe('"normal, text"')
  })
})
describe('generation context audit links', () => {
  it('deduplicates identical snapshots and gives changed retry context a new immutable link', () => {
    const first = taskContextLinkId('task_1', { product: { title: '旧标题' }, rules: ['v1'] })
    expect(taskContextLinkId('task_1', { rules: ['v1'], product: { title: '旧标题' } })).toBe(first)
    expect(taskContextLinkId('task_1', { product: { title: '新标题' }, rules: ['v2'] })).not.toBe(first)
  })
})
describe('publish batch state', () => {
  it('does not report submitted items as completed before final receipts', () => {
    expect(batchStateFromItems([{ taskId: 'task_1', platform: 'taobao', state: 'submitted' }])).toBe('queued')
    expect(batchStateFromItems([
      { taskId: 'task_1', platform: 'taobao', state: 'published' },
      { taskId: 'task_2', platform: 'taobao', state: 'submitted' },
    ])).toBe('queued')
    expect(batchStateFromItems([{ taskId: 'task_1', platform: 'taobao', state: 'published' }])).toBe('completed')
  })
})
describe('Codex-native Automation boundary', () => {
  it('fails closed for the legacy internal scheduler in production by default', () => {
    expect(internalAutomationTickAllowed({ NODE_ENV: 'production' })).toBe(false)
    expect(internalAutomationTickAllowed({ NODE_ENV: 'production', MERCHANT_INTERNAL_AUTOMATION_TICK_ENABLED: 'false' })).toBe(false)
    expect(internalAutomationTickAllowed({ NODE_ENV: 'production', MERCHANT_INTERNAL_AUTOMATION_TICK_ENABLED: 'true' })).toBe(true)
    expect(internalAutomationTickAllowed({ NODE_ENV: 'test' })).toBe(true)
  })
})
describe('protected product provider prompts', () => {
  it('appends every immutable product constraint before an image provider call', () => {
    const providerPrompt = appendProtectedProductConstraints('调整海边场景和柔和光影')
    expect(providerPrompt).toContain('调整海边场景和柔和光影')
    for (const protectedAttribute of ['商品本体颜色', '商品结构', '商品材质', '原始 Logo', '包装、标签和商品表面的全部原始文字', '认证、合规、防伪和许可标识', '商品原有配件']) {
      expect(providerPrompt).toContain(protectedAttribute)
    }
    expect(providerPrompt).toContain('Immutable product constraints')
  })
})
describe('API application wiring', () => {
  it('rechecks canonical task scope before MCP and REST content generation', () => {
    const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')
    const planMcpHandler = source.slice(source.indexOf("case 'task.plan.confirm':"), source.indexOf("case 'content.generate':"))
    const mcpHandler = source.slice(source.indexOf("case 'content.generate':"), source.indexOf("case 'content.codex.prepare':"))
    const approveMcpHandler = source.slice(source.indexOf("case 'content.approve':"), source.indexOf("case 'content.modify':"))
    const modifyMcpHandler = source.slice(source.indexOf("case 'content.modify':"), source.indexOf("case 'content.restore':"))
    const restoreMcpHandler = source.slice(source.indexOf("case 'content.restore':"), source.indexOf("case 'publish.prepare':"))
    const reviewDecisionMcpHandler = source.slice(source.indexOf("case 'content.review.decide':"), source.indexOf("case 'content.versions':"))
    const codexHandler = source.slice(source.indexOf("case 'content.codex.commit':"), source.indexOf("case 'generation.get':"))
    const asyncHandler = source.slice(source.indexOf('const generationJobCreateMatch'), source.indexOf('const generationJobGetMatch'))
    const restHandler = source.slice(source.indexOf("const contentMatch = path.match"), source.indexOf("const approvalMatch = path.match"))
    const planRestHandler = source.slice(source.indexOf('const planConfirmMatch'), source.indexOf('async function runFixtureGenerationJob'))
    const approveRestHandler = source.slice(source.indexOf('const approvalMatch'), source.indexOf('const versionDiffMatch'))
    const modifyRestHandler = source.slice(source.indexOf('const versionModifyMatch'), source.indexOf('const versionReviewMatch'))
    const restoreRestHandler = source.slice(source.indexOf('const versionRestoreMatch'), source.indexOf('const versionExportMatch'))
    const reviewDecisionRestHandler = source.slice(source.indexOf('const versionReviewDecisionMatch'), source.indexOf('const versionRestoreMatch'))
    expect(planMcpHandler).toContain('await assertCanonicalTaskScopeForAction(task)')
    expect(mcpHandler).toContain('await assertCanonicalTaskScopeForAction(task)')
    expect(approveMcpHandler).toContain('await assertCanonicalTaskScopeForAction(task)')
    expect(modifyMcpHandler).toContain('await assertCanonicalTaskScopeForAction(scoped.task)')
    expect(restoreMcpHandler).toContain('await assertCanonicalTaskScopeForAction(scoped.task)')
    expect(reviewDecisionMcpHandler).toContain('await assertCanonicalTaskScopeForAction(scoped.task)')
    expect(codexHandler).toContain('await assertCanonicalTaskScopeForAction(task)')
    expect(asyncHandler).toContain('await assertCanonicalTaskScopeForAction(task)')
    expect(restHandler).toContain('await assertCanonicalTaskScopeForAction(task)')
    expect(planRestHandler).toContain('await assertCanonicalTaskScopeForAction(task)')
    expect(approveRestHandler).toContain('await assertCanonicalTaskScopeForAction(task)')
    expect(modifyRestHandler).toContain('await assertCanonicalTaskScopeForAction(scoped.task)')
    expect(restoreRestHandler).toContain('await assertCanonicalTaskScopeForAction(scoped.task)')
    expect(reviewDecisionRestHandler).toContain('await assertCanonicalTaskScopeForAction(scoped.task)')
  })

  it('uses the canonical CAS writer instead of writing only legacy title during canonical_read', () => {
    const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')
    const handler = source.slice(source.indexOf("case 'catalog.title.accept':"), source.indexOf("case 'catalog.import':"))
    expect(handler).toContain("readControl.mode === 'canonical_read'")
    expect(handler).toContain('updateCanonicalProductTitle')
    expect(handler.indexOf('updateCanonicalProductTitle')).toBeLessThan(handler.indexOf('service.acceptSeoGeoTitle'))
  })

  it('refuses to close a conflict while the current consistency report still contains it', () => {
    const report = canonicalConsistencyApiReport({ workspaceId: 'ws_recheck', legacyProducts: [{ id: 'p1', workspaceId: 'ws_recheck', brandId: 'brand-1' }], canonicalProducts: [{ id: 'c1', workspaceId: 'ws_recheck', brandId: 'brand-2', legacyProductId: 'p1' }], listings: [], campaignItems: [], tasks: [] }, 'postgres', '2026-08-31T00:00:00.000Z')
    expect(canonicalConflictResolutionCheck({ conflict: { legacyProductId: 'p1', code: 'CANONICAL_BRAND_MISMATCH' }, report })).toMatchObject({ passed: false, findingCodes: ['BRAND_SCOPE_MISMATCH'] })
    const repaired = canonicalConsistencyApiReport({ workspaceId: 'ws_recheck', legacyProducts: [{ id: 'p1', workspaceId: 'ws_recheck', brandId: 'brand-1' }], canonicalProducts: [{ id: 'c1', workspaceId: 'ws_recheck', brandId: 'brand-1', legacyProductId: 'p1' }], listings: [], campaignItems: [], tasks: [] }, 'postgres', '2026-08-31T00:00:00.000Z')
    expect(canonicalConflictResolutionCheck({ conflict: { legacyProductId: 'p1', code: 'CANONICAL_BRAND_MISMATCH' }, report: repaired })).toEqual({ passed: true, findingCodes: [] })
    expect(canonicalConflictResolutionCheck({ conflict: { legacyProductId: 'p1', code: 'CANONICAL_ID_COLLISION' }, report: repaired })).toMatchObject({ passed: false })
  })
  it('blocks canonical reads until one canonical product and one listing are verified', () => {
    expect(resolveCanonicalProductReadScope({ mode: 'legacy_shadow', candidates: [], listings: [] })).toBeUndefined()
    expect(resolveCanonicalProductReadScope({ mode: 'canonical_read', candidates: [], listings: [] })).toMatchObject({ status: 'blocked', code: 'CANONICAL_PRODUCT_MAPPING_REQUIRED', reason: 'CANONICAL_MAPPING_MISSING' })
    expect(resolveCanonicalProductReadScope({ mode: 'canonical_read', candidates: [{ id: 'cp_1', brandId: 'brand_1', title: '标准标题' }], listings: [] })).toMatchObject({ status: 'blocked', code: 'CANONICAL_PRODUCT_LISTING_REQUIRED' })
    expect(resolveCanonicalProductReadScope({ mode: 'canonical_read', candidates: [{ id: 'cp_1', brandId: 'brand_1', title: '标准标题' }], listings: [{ id: 'listing_1' }] })).toMatchObject({ status: 'blocked', code: 'CANONICAL_PRODUCT_FACTS_REQUIRED' })
    expect(resolveCanonicalProductReadScope({ mode: 'canonical_read', candidates: [{ id: 'cp_1', brandId: 'brand_1', title: '标准标题', facts: { category: '女装' } }], listings: [{ id: 'listing_1' }] })).toEqual({ status: 'verified', canonicalProductId: 'cp_1', brandId: 'brand_1', listingId: 'listing_1', title: '标准标题', facts: { category: '女装' } })
  })
  it('publishes API-owned canonical consistency evidence without changing the domain report', () => {
    const input = {
      workspaceId: 'ws_api_contract',
      legacyProducts: [{ id: 'legacy_1', workspaceId: 'ws_api_contract' }], canonicalProducts: [], listings: [], campaignItems: [], tasks: [], publishJobs: [],
    }
    const result = canonicalConsistencyApiReport(input, 'postgres', '2026-08-31T00:00:00.000Z')
    expect(result).toMatchObject({ workspaceId: 'ws_api_contract', generatedAt: '2026-08-31T00:00:00.000Z', readMode: 'live', freshness: 'fresh', revision: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    expect(result.findings[0]).toMatchObject({ productId: 'legacy_1', canonicalProductId: null, scope: { brandId: null, platform: null, accountId: null, listingId: null }, relation: { listingIds: [], campaignItemIds: [], taskIds: [], publishJobIds: [] }, blocking: { code: 'CANONICAL_MAPPING_MISSING', retryable: true }, nextAction: { method: 'brand-unit.product.create', confirmation: 'interactive_confirmation', permission: { allowed: false, requiredRole: 'platform_ops' } }, evidence: { codes: ['CANONICAL_MAPPING_MISSING'], generatedAt: '2026-08-31T00:00:00.000Z', revision: expect.stringMatching(/^[a-f0-9]{64}$/u) } })
  })
  it('creates stable, retry-safe conflict queue items from consistency findings', () => {
    const report = canonicalConsistencyApiReport({ workspaceId: 'ws_scan', legacyProducts: [{ id: 'legacy_b', workspaceId: 'ws_scan' }, { id: 'legacy_a', workspaceId: 'ws_scan' }], canonicalProducts: [], listings: [], campaignItems: [], tasks: [], publishJobs: [] }, 'memory', '2026-08-31T00:00:00.000Z')
    const first = canonicalConflictScanItems(report)
    const second = canonicalConflictScanItems(report)
    expect(first).toEqual(second)
    expect(first).toEqual([
      { legacyProductId: 'legacy_a', code: 'CANONICAL_MAPPING_MISSING', canonicalIds: [] },
      { legacyProductId: 'legacy_b', code: 'CANONICAL_MAPPING_MISSING', canonicalIds: [] },
    ])
  })

  it('keeps task account mismatches in the human-review backfill queue', () => {
    const report = canonicalConsistencyApiReport({
      workspaceId: 'ws_task_conflict',
      legacyProducts: [{ id: 'product_1', workspaceId: 'ws_task_conflict', platform: 'jd', accountId: 'account_old' }],
      canonicalProducts: [{ id: 'canonical_1', workspaceId: 'ws_task_conflict', brandId: 'brand_1', legacyProductId: 'product_1' }],
      listings: [{ id: 'listing_1', workspaceId: 'ws_task_conflict', brandId: 'brand_1', canonicalProductId: 'canonical_1', platform: 'jd', accountId: 'account_old' }],
      campaignItems: [],
      tasks: [{ id: 'task_1', workspaceId: 'ws_task_conflict', productId: 'product_1', platform: 'jd', accountId: 'account_new' }],
      publishJobs: [],
    }, 'memory', '2026-08-31T00:00:00.000Z')
    expect(canonicalConflictScanItems(report)).toContainEqual({ legacyProductId: 'product_1', code: 'TASK_ACCOUNT_MISMATCH', canonicalIds: ['canonical_1'] })
  })

  it('keeps canonical read rollout fail-closed and routed through the feature-flag control plane', () => {
    const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')
    expect(source).toContain('CANONICAL_PRODUCT_READ_MODE_FLAG')
    expect(source).toContain("mode: 'legacy_shadow'")
    expect(source).toContain('canonicalProductReadModeFromFlag')
    expect(source).toContain('read_control: readControl')
  })

  it('keeps platform control-plane scope explicit and excludes customer surfaces', () => {
    expect(isPlatformScopeMethod('ops.commercial.model-markup.get')).toBe(true)
    expect(isPlatformScopeMethod('ops.feature-flags.list')).toBe(true)
    expect(isPlatformScopeMethod('ops.audit.list')).toBe(false)
    expect(isPlatformScopeMethod('ops.support.tickets.list')).toBe(false)
    expect(isPlatformScopeMethod('content.list')).toBe(false)
  })
  it('hydrates knowledge before both merchant and knowledge-ops reads after a restart', () => {
    expect(shouldHydrateKnowledgeForMethod('knowledge.rule.list', false, true)).toBe(true)
    expect(shouldHydrateKnowledgeForMethod('ops.audit.list', false, true)).toBe(false)
    expect(shouldHydrateKnowledgeForMethod('catalog.search', false, false)).toBe(true)
    expect(shouldHydrateKnowledgeForMethod('knowledge.rule.list', true, true)).toBe(false)
  })

  it('releases settled storage quota only after confirmed object deletion', async () => {
    const releases: string[] = []
    const quota = { releaseAfterPhysicalDeletion: async (input: { workspaceId: string; reservationKey: string }) => { releases.push(`${input.workspaceId}:${input.reservationKey}`) } } as never
    await releaseStorageQuotaAfterConfirmedDeletion({ quota, workspaceId: 'ws_quota_api', reservationKey: 'asset:a1', objectKey: 'clean/ws_quota_api/a1.bin', deleteObject: async () => undefined })
    expect(releases).toEqual(['ws_quota_api:asset:a1'])
    await releaseStorageQuotaAfterConfirmedDeletion({ quota, workspaceId: 'ws_quota_api', reservationKey: 'asset:a2', objectKey: 'clean/ws_quota_api/a2.bin', deleteObject: async () => false })
    expect(releases).toEqual(['ws_quota_api:asset:a1'])
    await expect(releaseStorageQuotaAfterConfirmedDeletion({ quota, workspaceId: 'ws_quota_api', reservationKey: 'asset:a3', objectKey: 'clean/ws_quota_api/a3.bin', deleteObject: async () => { throw new Error('delete failed') } })).rejects.toThrow('delete failed')
    expect(releases).toEqual(['ws_quota_api:asset:a1'])
  })

  it('routes every real quarantine object write through quota and atomic asset persistence', () => {
    const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')
    expect((source.match(/const stored = await putQuarantineObject\(/gu) ?? [])).toHaveLength(6)
    expect((source.match(/await persistAssetSnapshotAndEvent\(workspaceId,/gu) ?? [])).toHaveLength(5)
    expect((source.match(/compensateStoredAsset\(/gu) ?? [])).toHaveLength(7)
    expect(source).toContain('const quota = persistence.storageQuota')
    expect(source).toContain('onDeleted: async row =>')
    expect(source).toContain('releaseAfterPhysicalDeletion')
    const dataDeletionStart = source.indexOf("path === '/v1/ops/data-deletion/complete'")
    const orphanCleanupStart = source.indexOf("path === '/v1/internal/storage/orphans/cleanup'")
    expect(dataDeletionStart).toBeGreaterThanOrEqual(0)
    expect(source.slice(dataDeletionStart, orphanCleanupStart)).not.toContain('releaseAfterPhysicalDeletion')
    expect(source).toContain("if (target.mode === 'postgres') throw new DomainError('ASSET_PERSISTENCE_ATOMIC_REQUIRED'")
  })

  it('keeps model usage reconciliation worker-only and shares the MCP settlement path', () => {
    const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')
    expect(source).toContain("path === '/v1/internal/model-usage/reconciliation'")
    expect(source).toContain("const reconciliation = await runModelUsageReconciliation({ workspaceId, actorId, limit })")
    expect(source).toContain("action: 'billing.model-usage.reconciliation.worker'")
    expect(source).toContain("if (req.method === 'POST' && path === '/v1/internal/model-usage/reconciliation')")
    expect(source).toContain('requireWorkerAuthorization(req)')
  })

  it('projects SLA scan actions into durable operational alerts without coupling webhook latency', () => {
    const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')
    const start = source.indexOf('async function runSupportSlaScan(')
    const end = source.indexOf("if (req.method === 'POST' && path === '/v1/internal/support/sla-scan')", start)
    const scan = source.slice(start, end)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(scan).toContain('repository.recordSlaAction')
    expect(scan).toContain("alertKey: `support-sla:${action.ticketId}:${action.state}:${action.dueAt}`")
    expect(scan).toContain("code: action.state === 'breached' ? 'SUPPORT_SLA_BREACHED' : 'SUPPORT_SLA_AT_RISK'")
    expect(scan).toContain('void persistOperationalAlertNotification(alert)')
  })

  it('keeps durable image admission explicit and emits one frozen request event', () => {
    const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')
    expect(source).toContain("process.env.IMAGE_GENERATION_EXECUTION_MODE?.trim().toLowerCase() === 'durable'")
    expect(source).toContain("eventType: 'image.generation.requested'")
    expect(source).toContain('if (!existingImageJob) await persistence.persistSnapshotAndEvent')
    expect(source).toContain("type: 'get_status', label: '查询任务状态'")
    expect(source).toContain("IMAGE_GENERATION_DURABLE_NOT_CONFIGURED")
  })

  it('keeps image callback and execution lease boundaries worker-only and validates receipt before archiving', () => {
    const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')
    expect(source).toContain("/^\\/v1\\/internal\\/image-generation-jobs\\/[^/]+\\/result$/")
    expect(source).toContain("/^\\/v1\\/internal\\/image-generation-jobs\\/[^/]+\\/execution$/")
    expect(source).toContain('validateImageGenerationCallbackResult(input, { allowEventId: true })')
    expect(source).toContain("if (!requested) throw new DomainError('IMAGE_GENERATION_EVENT_INVALID'")
    expect(source).toContain("if (requested.payload.intent_hash !== intentHash)")
    expect(source).toContain('async function persistImageGenerationCompletion')
    expect(source).toContain('await persistImageGenerationCompletion(workspaceId, job)')
    expect(source).toContain('await persistImageGenerationCompletion(workspaceId, archived)')
    const receiptStart = source.indexOf("const imageGenerationResultMatch = path.match")
    const archiveCall = source.indexOf('const archived = await archiveGeneratedImages', receiptStart)
    const eventBinding = source.indexOf("if (!requested) throw new DomainError('IMAGE_GENERATION_EVENT_INVALID'", receiptStart)
    expect(receiptStart).toBeGreaterThanOrEqual(0)
    expect(eventBinding).toBeGreaterThan(receiptStart)
    expect(archiveCall).toBeGreaterThan(eventBinding)
    expect(source).toContain('const workerNeedsWorkspaceHydration = workerRoute')
    expect(source).toContain("path === '/v1/internal/image-generation-jobs/reconciliation'")
    expect(source).toContain('(!workerRoute || workerNeedsWorkspaceHydration)')
  })

  it('keeps image Provider reconciliation tenant-bound, idempotent, and fail-closed', () => {
    const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')
    const reconciliationStart = source.indexOf("if (req.method === 'POST' && path === '/v1/internal/image-generation-jobs/reconciliation')")
    const reconciliationEnd = source.indexOf("path === '/v1/internal/model-usage/reconciliation'", reconciliationStart)
    expect(reconciliationStart).toBeGreaterThanOrEqual(0)
    expect(reconciliationEnd).toBeGreaterThan(reconciliationStart)
    const reconciliation = source.slice(reconciliationStart, reconciliationEnd)

    // The worker header and request body must agree before any execution is read.
    expect(reconciliation).toContain('requireWorkerAuthorization(req)')
    expect(reconciliation).toContain("const workspaceId = headerRequired(req, 'x-workspace-id')")
    expect(reconciliation).toContain("input.workspace_id !== undefined && input.workspace_id !== workspaceId")
    expect(reconciliation).toContain("throw new DomainError(ERROR_CODES.TENANT_SCOPE_DENIED")

    // Pagination cursors are validated by the repository with the workspace,
    // state filter and scan watermark bound into the signed payload.
    expect(reconciliation).toContain('repository.listPage({ workspaceId')
    expect(reconciliation).toContain('input.cursor === undefined')
    expect(reconciliation).toContain("typeof input.cursor === 'string'")
    expect(reconciliation).toContain("cursor 必须是非空字符串")

    // The compatibility scan endpoint never owns Provider credentials or
    // performs a lookup. Provider observations must arrive through the Worker
    // evidence contract below.
    expect(reconciliation).toContain('execution.providerRequestId')
    expect(reconciliation).toContain('reconciliation_required: true')
    expect(reconciliation).toContain('API 禁止直接查询 Provider')
    expect(reconciliation).not.toContain('queryStatus')

    // Completion is compare-and-set guarded by the execution repository; a
    // replayed page cannot create a second terminal transition.
    expect(reconciliation).toContain('repository.reconcileCompleted({ workspaceId, jobId: job.id })')
    expect(reconciliation).toContain('repository.reconcileFailed({ workspaceId, jobId: job.id')
  })

  it('projects real Provider dispatch states through the image list and reconciliation APIs', () => {
    const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')
    const listStart = source.indexOf("if (req.method === 'GET' && path === '/v1/image-generation-jobs')")
    const listEnd = source.indexOf("const imageGenerationJobGetMatch", listStart)
    expect(listStart).toBeGreaterThanOrEqual(0)
    expect(listEnd).toBeGreaterThan(listStart)
    const list = source.slice(listStart, listEnd)
    expect(list).toContain('publicImageJobExecutionProjection(workspaceId, job.id)')
    expect(list).toContain('...await publicImageJobExecutionProjection(workspaceId, job.id)')
    expect(source).toContain('executionState: execution?.state ?? null')
    expect(source).toContain('reconciliationRequired: execution?.state === \'provider_reserved\'')
    expect(source).toContain("reconciliation_required: execution?.state === 'provider_reserved' || execution?.state === 'provider_dispatching'")
    expect(source).toContain("states: ['provider_reserved', 'provider_dispatching', 'provider_started', 'outcome_unknown']")

    const queueStart = source.indexOf("case 'ops.marketing.queue':")
    const queueEnd = source.indexOf("case 'ops.marketing.queue.assign':", queueStart)
    expect(queueStart).toBeGreaterThanOrEqual(0)
    expect(queueEnd).toBeGreaterThan(queueStart)
    const queue = source.slice(queueStart, queueEnd)
    expect(queue).toContain("states: ['provider_reserved', 'provider_dispatching', 'provider_started', 'outcome_unknown']")

    const reconciliationStart = source.indexOf("if (req.method === 'POST' && path === '/v1/internal/image-generation-jobs/reconciliation')")
    const reconciliationEnd = source.indexOf("path === '/v1/internal/model-usage/reconciliation'", reconciliationStart)
    const reconciliation = source.slice(reconciliationStart, reconciliationEnd)
    expect(reconciliation).toContain('execution_state: execution.state')
    expect(reconciliation).toContain('provider_request_id: execution.providerRequestId ?? null')
    expect(reconciliation).toContain('execution_attempt: execution.attempt')
  })

  it('accepts only Worker-owned Provider evidence and reuses archive/CAS transitions', () => {
    const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')
    const start = source.indexOf('const imageGenerationEvidenceMatch = path.match')
    const end = source.indexOf("if (req.method === 'POST' && path === '/v1/internal/model-usage')", start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const contract = source.slice(start, end)
    expect(contract).toContain('requireWorkerAuthorization(req)')
    expect(contract).toContain("headerRequired(req, 'x-workspace-id')")
    expect(contract).toContain("input.workspace_id !== undefined && input.workspace_id !== workspaceId")
    expect(contract).toContain('ERROR_CODES.TENANT_SCOPE_DENIED')
    expect(contract).toContain('persistence.imageGenerationExecutions')
    expect(contract).toContain('persistence.reconciliationEvidence')
    expect(contract).toContain('execution.eventId !== eventId')
    expect(contract).toContain('job.intentHash !== intentHash')
    expect(contract).toContain('execution.providerRequestId !== providerRequestId')
    expect(contract).toContain('evidenceRepository.append({')
    expect(contract).toContain('archiveGeneratedImages(workspaceId, job.id, images)')
    expect(contract).toContain('repository.reconcileCompleted({ workspaceId, jobId: job.id })')
    expect(contract).toContain('repository.reconcileFailed({ workspaceId, jobId: job.id')
    expect(contract).toContain("providerStateValue === 'processing'")
    expect(contract).toContain('reconciliation_required: true')
    expect(contract).not.toContain('imageGenerator.queryStatus')
  })

  it('derives reconciliation idempotency from the complete stable identity tuple', () => {
    const input = { workspaceId: 'ws_a', jobId: 'job_1', eventId: 'event_1', intentHash: 'a'.repeat(64), executionAttempt: 2, providerRequestId: 'provider_1', queryAttempt: 3 } as const
    const key = imageGenerationReconciliationIdempotencyKey(input)
    expect(key).toMatch(/^image-reconcile:[a-f0-9]{64}$/u)
    expect(key).toBe(workerImageReconciliationIdempotencyKey(input))
    expect(key).not.toBe(imageGenerationReconciliationIdempotencyKey({ ...input, workspaceId: 'ws_b' }))
    expect(key).not.toBe(imageGenerationReconciliationIdempotencyKey({ ...input, eventId: 'event_2' }))
    expect(key).not.toBe(imageGenerationReconciliationIdempotencyKey({ ...input, intentHash: 'b'.repeat(64) }))
    expect(key).not.toBe(imageGenerationReconciliationIdempotencyKey({ ...input, executionAttempt: 3 }))
    expect(key).not.toBe(imageGenerationReconciliationIdempotencyKey({ ...input, providerRequestId: 'provider_2' }))
    expect(key).not.toBe(imageGenerationReconciliationIdempotencyKey({ ...input, queryAttempt: 4 }))
  })

  it('rejects a caller-supplied reconciliation key that does not match the server tuple', () => {
    const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')
    const start = source.indexOf('const imageGenerationEvidenceMatch = path.match')
    const end = source.indexOf("if (req.method === 'POST' && path === '/v1/internal/model-usage')", start)
    const contract = source.slice(start, end)
    expect(contract).toContain('const expectedIdempotencyKey = imageGenerationReconciliationIdempotencyKey({')
    expect(contract).toContain('idempotencyKey !== expectedIdempotencyKey')
    expect(contract).toContain("IMAGE_GENERATION_EVIDENCE_IDEMPOTENCY_KEY_INVALID")
  })

  it('rejects a Provider result whose request id does not match the leased execution', () => {
    const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')
    const resultStart = source.indexOf('const imageGenerationResultMatch = path.match')
    expect(resultStart).toBeGreaterThanOrEqual(0)
    expect(source.slice(resultStart, resultStart + 9000)).toContain("IMAGE_GENERATION_PROVIDER_REQUEST_ID_MISMATCH")
    expect(source.slice(resultStart, resultStart + 9000)).toContain('providerRequestId !== execution.providerRequestId')
  })

  it('uses one atomic persistence call for a quarantined asset and its lifecycle event', async () => {
    const calls: Array<Record<string, unknown>> = []
    await persistAssetSnapshotAndEvent('ws_asset_atomic', { id: 'asset_atomic', revision: 3 }, 'asset.generated_quarantined', { asset_id: 'asset_atomic' }, { id: 'asset_atomic', revision: 3, storageKey: 'quarantine/ws_asset_atomic/a' }, {
      mode: 'postgres',
      persistSnapshotAndEvent: async input => { calls.push(input as unknown as Record<string, unknown>) },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ workspaceId: 'ws_asset_atomic', entityType: 'asset', entityId: 'asset_atomic', entityVersion: 3, eventType: 'asset.generated_quarantined', eventPayload: { asset_id: 'asset_atomic' } })
  })

  it('uses the same customer-data grant boundary for HTTP and MCP transports', () => {
    expect(customerDataMethodForHttp('GET', '/v1/products')).toBe('catalog.search')
    expect(customerDataMethodForHttp('GET', '/v1/assets/a1/products')).toBe('catalog.search')
    expect(customerDataMethodForHttp('POST', '/v1/publish-jobs')).toBe('catalog.product.update')
    expect(customerDataMethodForHttp('GET', '/v1/platform-accounts')).toBe('platform.store.list')
    expect(customerDataMethodForHttp('POST', '/v1/platform-accounts/taobao/authorize')).toBe('platform.connect')
    expect(customerDataMethodForHttp('POST', '/v1/platform-accounts/taobao/sync')).toBe('platform.sync')
    expect(customerDataMethodForHttp('DELETE', '/v1/platform-accounts/taobao')).toBe('platform.revoke')
    expect(customerDataMethodForHttp('GET', '/v1/platform-capabilities')).toBeUndefined()
    expect(customerDataMethodForHttp('GET', '/healthz')).toBeUndefined()
  })

  it('requires a signed, actor/workspace-bound, short-lived customer data grant', () => {
    const secret = 'test-ops-customer-access-secret'
    const nowSeconds = 1_800_000_000
    const sign = (payload: Record<string, unknown>) => {
      const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
      const signature = createHmac('sha256', secret).update(`v1.${encoded}`).digest('base64url')
      return `v1.${encoded}.${signature}`
    }
    const base = { grant_id: 'grant_123456', actor_id: 'ops_1', workspace_id: 'ws_1', issued_at: nowSeconds - 30, expires_at: nowSeconds + 300 }

    expect(() => validateCustomerDataAccessGrant(undefined, { actorId: 'ops_1', workspaceId: 'ws_1', method: 'catalog.search', nowSeconds }, secret)).toThrowError(expect.objectContaining({ code: 'OPS_CUSTOMER_ACCESS_REQUIRED' }))
    expect(() => validateCustomerDataAccessGrant(sign({ ...base, scopes: ['customer_data.read'] }), { actorId: 'ops_1', workspaceId: 'ws_1', method: 'catalog.product.update', nowSeconds }, secret)).toThrowError(expect.objectContaining({ code: 'OPS_CUSTOMER_ACCESS_INVALID' }))
    expect(validateCustomerDataAccessGrant(sign({ ...base, scopes: ['customer_data.read'] }), { actorId: 'ops_1', workspaceId: 'ws_1', method: 'catalog.search', nowSeconds }, secret)).toMatchObject({ grantId: 'grant_123456', workspaceId: 'ws_1' })
    expect(() => validateCustomerDataAccessGrant(sign({ ...base, scopes: ['customer_data.read'] }), { actorId: 'ops_1', workspaceId: 'ws_1', method: 'catalog.search', nowSeconds: nowSeconds + 301 }, secret)).toThrowError(expect.objectContaining({ code: 'OPS_CUSTOMER_ACCESS_INVALID' }))
    expect(validateCustomerDataAccessGrant(sign({ ...base, scopes: ['customer_data.write'] }), { actorId: 'ops_1', workspaceId: 'ws_1', method: 'catalog.product.update', nowSeconds }, secret)).toMatchObject({ actorId: 'ops_1' })
    expect(validateCustomerDataAccessGrant(sign({ ...base, scopes: ['customer_data.read'] }), { actorId: 'ops_1', workspaceId: 'ws_1', method: 'ops.audit.detail', nowSeconds }, secret)).toMatchObject({ actorId: 'ops_1' })
  })

  it('bounds soft knowledge context while retaining every hard rule with deterministic ranking', () => {
    const rule = (id: string, updatedAt: string, hard: boolean) => ({ id, updatedAt, severity: hard ? 'error' : 'info', action: hard ? 'block' : 'suggest', content: `规则 ${id}`, version: id, source: { reference: `test://${id}` }, scope: 'global', name: id, target: {}, ownerId: 'test', status: 'active', tags: [], revision: 1, createdAt: updatedAt }) as never
    const suggestion = (id: string, updatedAt: string) => ({ id, updatedAt, summary: `建议 ${id}`, proposedRule: { content: `建议规则 ${id}`, scope: 'global', version: id } }) as never
    const rules = [rule('soft-old', '2026-08-01T00:00:00.000Z', false), rule('hard-a', '2026-08-01T00:00:00.000Z', true), ...Array.from({ length: KNOWLEDGE_CONTEXT_LIMITS.softRules + 2 }, (_, index) => rule(`soft-${String(index).padStart(2, '0')}`, `2026-08-${String(index + 2).padStart(2, '0')}T00:00:00.000Z`, false)), rule('hard-b', '2026-08-02T00:00:00.000Z', true)]
    const suggestions = Array.from({ length: KNOWLEDGE_CONTEXT_LIMITS.confirmedLearningSuggestions + 2 }, (_, index) => suggestion(`learning-${String(index).padStart(2, '0')}`, `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`))

    const first = buildBoundedKnowledgeGenerationContext({ rules, learningSuggestions: suggestions })
    const second = buildBoundedKnowledgeGenerationContext({ rules: [...rules].reverse(), learningSuggestions: [...suggestions].reverse() })

    expect(first.rules.filter(item => item.id.startsWith('hard-')).map(item => item.id)).toEqual(['hard-a', 'hard-b'])
    expect(first.rules).toHaveLength(KNOWLEDGE_CONTEXT_LIMITS.softRules + 2)
    expect(first.confirmedLearningSuggestions).toHaveLength(KNOWLEDGE_CONTEXT_LIMITS.confirmedLearningSuggestions)
    expect(first.confirmedLearningSuggestions.map(item => item.id)).toEqual(['learning-09', 'learning-08', 'learning-07', 'learning-06', 'learning-05', 'learning-04', 'learning-03', 'learning-02'])
    expect(second).toEqual(first)
  })

  it('aggregates products and sync jobs once per account for the store directory', () => {
    const workspaceId = `ws_store_directory_${Date.now()}`
    const accountA = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: 'remote-a', credentialRef: 'fixture://a' })
    const accountB = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: 'remote-b', credentialRef: 'fixture://b' })
    service.importProduct({ workspaceId, platform: 'taobao', accountId: accountA.id, storeName: '北区店', title: '商品 A', stock: 1 })
    service.importProduct({ workspaceId, platform: 'taobao', accountId: accountA.id, storeName: '南区店', title: '商品 B', stock: 1 })
    const olderA = service.createSyncJob({ workspaceId, platform: 'taobao', accountId: accountA.id })
    service.updateSyncJob(workspaceId, olderA.id, { state: 'partial', itemsFailed: 1 })
    const latestA = service.createSyncJob({ workspaceId, platform: 'taobao', accountId: accountA.id })
    service.updateSyncJob(workspaceId, latestA.id, { state: 'succeeded', itemsFailed: 2 })
    olderA.updatedAt = '2026-08-29T00:00:00.000Z'
    latestA.updatedAt = '2026-08-29T01:00:00.000Z'

    const products = service.listProducts(workspaceId)
    const syncJobs = service.listSyncJobs(workspaceId)
    const productFilter = vi.spyOn(products, 'filter')
    const productSome = vi.spyOn(products, 'some')
    const syncFilter = vi.spyOn(syncJobs, 'filter')
    const listProducts = vi.spyOn(service, 'listProducts').mockReturnValue(products)
    const listSyncJobs = vi.spyOn(service, 'listSyncJobs').mockReturnValue(syncJobs)
    try {
      const directory = workspaceStoreDirectory(workspaceId, 'taobao')
      expect(directory).toEqual(expect.arrayContaining([
        expect.objectContaining({ accountId: accountA.id, storeName: '北区店 等 2 个店铺名', sync: expect.objectContaining({ latestState: 'succeeded', failedItems: 2, lastSuccessfulAt: latestA.updatedAt }) }),
        expect.objectContaining({ accountId: accountB.id, sync: expect.objectContaining({ latestState: null, lastSuccessfulAt: null, lastUsableAt: null, failedItems: 0 }) }),
      ]))
      expect(listProducts).toHaveBeenCalledTimes(1)
      expect(listSyncJobs).toHaveBeenCalledTimes(1)
      expect(productFilter).not.toHaveBeenCalled()
      expect(productSome).not.toHaveBeenCalled()
      expect(syncFilter).not.toHaveBeenCalled()
    } finally {
      listProducts.mockRestore()
      listSyncJobs.mockRestore()
      productFilter.mockRestore()
      productSome.mockRestore()
      syncFilter.mockRestore()
    }
  })

  it('reads workspace status inside the transaction that owns the RLS scope', async () => {
    const queries: string[] = []
    let inTransaction = false
    let workspaceScope = ''
    const pool: SqlPool = { connect: async () => ({
      query: async <Row>(text: string, values?: readonly unknown[]) => {
        queries.push(text)
        if (text === 'BEGIN') inTransaction = true
        if (text.includes("set_config('app.workspace_id'")) workspaceScope = String(values?.[0] ?? '')
        if (text.startsWith('SELECT status')) return { rows: inTransaction && workspaceScope === 'ws_disabled' ? [{ status: 'disabled' } as Row] : [] }
        if (text === 'COMMIT' || text === 'ROLLBACK') inTransaction = false
        return { rows: [] }
      },
      release: () => undefined,
    }) }

    await expect(readWorkspaceStatusInTransaction(pool, 'ws_disabled')).resolves.toBe('disabled')
    expect(queries).toEqual(['BEGIN', expect.stringContaining("set_config('app.workspace_id'"), 'SELECT status FROM workspaces WHERE id = $1', 'COMMIT'])
  })

  it('exposes a fail-closed health state before real platform configuration', () => {
    const health = service.health()
    expect(health.status).toBe('ok')
    expect(health.writesEnabled).toBe(false)
    expect(health.connectors.jd).toBe('not_configured')
  })

  it('labels local fallback output as simulated and provider output as executed', () => {
    expect(executionContract('image', false)).toMatchObject({ mode: 'simulated', simulated: true, providerExecuted: false, label: '本地演示图片，未调用图片模型' })
    expect(executionContract('ocr', false)).toMatchObject({ mode: 'simulated', simulated: true, providerExecuted: false })
    expect(executionContract('content', true)).toMatchObject({ mode: 'provider', simulated: false, providerExecuted: true, label: '已由配置的内容模型生成' })
    expect(executionContract('video', true, 'text-relay')).toMatchObject({ mode: 'provider', providerKind: 'text-relay' })
  })

  it('labels terminal outbox failures as dead letters instead of delivered events', () => {
    const event = timelineEvent({ id: 'evt_dead', workspaceId: 'ws_a', aggregateId: 'gen_a', eventType: 'generation.requested', sequence: 1, payload: {}, publishedAt: new Date().toISOString(), createdAt: new Date().toISOString(), lastError: { code: 'GENERATION_JOB_TERMINAL', retryable: false } })
    expect(event.delivery).toBe('dead_letter')
  })
})
