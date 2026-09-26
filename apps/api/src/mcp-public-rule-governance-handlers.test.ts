import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { PersistedRuleAudit, PersistedRuleVersion } from '../../../packages/persistence/src/index.js'
import { handlePublicRuleDraftsGet, handlePublicRuleDraftsList } from './mcp-public-rule-governance-handlers.js'

const request = {} as import('node:http').IncomingMessage
const manualChecks = { forbiddenTerms: ['全网最低'] }
const manualChecksum = createHash('sha256').update(JSON.stringify(manualChecks)).digest('hex')
const version = (overrides: Partial<PersistedRuleVersion> = {}): PersistedRuleVersion => ({
  id: 'public-rule-1', workspaceId: '__platform_rules__', packId: 'pdd-copy', name: 'PDD listing claims', version: '3',
  scope: 'platform', status: 'draft', sourceKind: 'internal', sourceReference: 'manual://rules.md#PDD-1',
  sourceCheckedAt: '2026-09-25T10:00:00.000Z', checksum: manualChecksum, checks: { ...manualChecks, __public_scope: 'platform' },
  createdAt: '2026-09-25T10:01:00.000Z', updatedAt: '2026-09-25T10:01:00.000Z', createdBy: 'actor-author', revision: 1,
  scopeValue: 'pinduoduo', severity: 'error', action: 'block', ...overrides,
})
const auditRow: PersistedRuleAudit = {
  id: 'public-audit-1', workspaceId: '__platform_rules__', rulePackId: 'pdd-copy', ruleVersionId: 'public-rule-1', version: '3',
  action: 'created', actorId: 'actor-author', reason: 'manual review submission', occurredAt: '2026-09-25T10:01:00.000Z', data: { checksum: 'checks-sha256' },
}

function setup(options: { authorized?: boolean } = {}) {
  const repo = {
    listPublicDraftsForReview: vi.fn(async () => ({ items: [version()], nextCursor: { createdAt: '2026-09-25T10:01:00.000Z', id: 'public-rule-1' } })),
    getPublicRuleForReview: vi.fn(async (platform: string, packId: string, requestedVersion: string) => platform === 'pinduoduo' && packId === 'pdd-copy' && requestedVersion === '3' ? version() : undefined),
    listPublicRuleAuditForReview: vi.fn(async () => [auditRow]),
  }
  const deps = {
    result: (value: unknown) => value,
    required: (params: Record<string, unknown>, key: string) => {
      const value = params[key]
      if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} required`)
      return value
    },
    ruleRepository: () => repo as never,
    requirePlatformRuleReviewer: vi.fn(() => {
      if (options.authorized === false) throw Object.assign(new Error('forbidden'), { status: 403 })
      return { actorId: 'reviewer-2', workbench: 'platform' }
    }),
    supportedPlatforms: ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'],
    canonicalJson: (value: unknown) => JSON.stringify(value) ?? '',
  }
  return { repo, deps }
}

describe('public platform rule governance preview handler', () => {
  it('lists draft reviews with a bounded cursor and returns no tenant ownership', async () => {
    const { repo, deps } = setup()
    const result = await handlePublicRuleDraftsList(request, { platform: 'pinduoduo', limit: '20' }, deps) as { items: Array<Record<string, unknown>>; next_cursor: string }
    expect(repo.listPublicDraftsForReview).toHaveBeenCalledWith({ platform: 'pinduoduo', limit: 20, cursor: undefined })
    expect(result.items[0]).toMatchObject({ platform: 'pinduoduo', category: 'platform', status: 'draft', checksum_valid: true, source: { trust: 'manual_pending_review' }, checks: { forbiddenTerms: ['全网最低'] } })
    expect(result.items[0]).not.toHaveProperty('workspaceId')
    expect(result.items[0]?.checks).not.toHaveProperty('__public_scope')
    expect(result.next_cursor).toBeTruthy()
  })

  it('requires the platform reviewer authorization before querying the repository', async () => {
    const { repo, deps } = setup({ authorized: false })
    await expect(handlePublicRuleDraftsList(request, {}, deps)).rejects.toMatchObject({ status: 403 })
    expect(repo.listPublicDraftsForReview).not.toHaveBeenCalled()
    expect(repo.getPublicRuleForReview).not.toHaveBeenCalled()
  })

  it('rejects unsupported platforms, malformed cursors and unbounded limits', async () => {
    const { repo, deps } = setup()
    await expect(handlePublicRuleDraftsList(request, { platform: 'unknown' }, deps)).rejects.toMatchObject({ status: 400 })
    await expect(handlePublicRuleDraftsList(request, { cursor: 'not-base64-json' }, deps)).rejects.toMatchObject({ status: 400 })
    await expect(handlePublicRuleDraftsList(request, { limit: '1000' }, deps)).rejects.toMatchObject({ status: 400 })
    expect(repo.listPublicDraftsForReview).not.toHaveBeenCalled()
  })

  it('loads an exact platform version with its audit trail and strips workspace metadata', async () => {
    const { repo, deps } = setup()
    const result = await handlePublicRuleDraftsGet(request, { platform: 'pinduoduo', pack_id: 'pdd-copy', version: '3' }, deps) as { rule: Record<string, unknown>; audit: Array<Record<string, unknown>> }
    expect(repo.getPublicRuleForReview).toHaveBeenCalledWith('pinduoduo', 'pdd-copy', '3')
    expect(repo.listPublicRuleAuditForReview).toHaveBeenCalledWith('pinduoduo', 'pdd-copy', '3')
    expect(result.rule).toMatchObject({ platform: 'pinduoduo', pack_id: 'pdd-copy', version: '3', created_by: 'actor-author' })
    expect(result.rule).not.toHaveProperty('workspaceId')
    expect(result.audit[0]).toMatchObject({ platform: 'pinduoduo', pack_id: 'pdd-copy', actor_id: 'actor-author', action: 'created' })
    expect(result.audit[0]).not.toHaveProperty('workspaceId')
  })

  it('returns not found without querying audits when the exact version is absent', async () => {
    const { repo, deps } = setup()
    repo.getPublicRuleForReview.mockResolvedValue(undefined)
    await expect(handlePublicRuleDraftsGet(request, { platform: 'jd', pack_id: 'other', version: '99' }, deps)).rejects.toMatchObject({ code: 'RULE_VERSION_NOT_FOUND' })
    expect(repo.listPublicRuleAuditForReview).not.toHaveBeenCalled()
  })

  it('does not label an active manual rule reviewed when its payload checksum is invalid', async () => {
    const { deps, repo } = setup()
    repo.getPublicRuleForReview.mockResolvedValue(version({ status: 'active', checksum: '0'.repeat(64) }))
    const result = await handlePublicRuleDraftsGet(request, { platform: 'pinduoduo', pack_id: 'pdd-copy', version: '3' }, deps) as { rule: Record<string, unknown> }
    expect(result.rule).toMatchObject({ status: 'active', checksum_valid: false, source: { trust: 'unverified' } })
  })

  it('does not label a signed import trusted when its payload checksum is invalid', async () => {
    const { deps, repo } = setup()
    repo.getPublicRuleForReview.mockResolvedValue(version({
      sourceKind: 'official', sourceReference: 'https://rules.example.test/pdd/4', createdBy: 'signed-rule-sync',
      status: 'active', checksum: '0'.repeat(64),
    }))
    const result = await handlePublicRuleDraftsGet(request, { platform: 'pinduoduo', pack_id: 'pdd-copy', version: '3' }, deps) as { rule: Record<string, unknown> }
    expect(result.rule).toMatchObject({ status: 'active', checksum_valid: false, source: { trust: 'unverified' } })
  })

  it('does not label a correctly checksummed signed import trusted without valid platform provenance', async () => {
    const { deps, repo } = setup()
    repo.getPublicRuleForReview.mockResolvedValue(version({
      scope: 'global', sourceKind: 'official', sourceReference: 'https://rules.example.test/pdd/4', createdBy: 'signed-rule-sync',
      status: 'active', checksum: manualChecksum,
    }))
    const result = await handlePublicRuleDraftsGet(request, { platform: 'pinduoduo', pack_id: 'pdd-copy', version: '3' }, deps) as { rule: Record<string, unknown> }
    expect(result.rule).toMatchObject({ status: 'active', checksum_valid: true, source: { trust: 'unverified' } })
  })
})
