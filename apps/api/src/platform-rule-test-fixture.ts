import { createHash } from 'node:crypto'
import { defaultRuleCenterSeeds } from '../../../packages/review/src/rule-center.js'
import { PLATFORM_RULE_SOURCES, type RuleSyncPlatform } from '../../../packages/review/src/platform-rule-sync.js'
import type { PersistedRuleAudit, PersistedRuleVersion } from '../../../packages/persistence/src/index.js'
import type { RuleRepositoryPort } from './server.js'

export class TrustedRuleTestRepository implements RuleRepositoryPort {
  readonly versions: PersistedRuleVersion[] = []
  /**
   * Shared platform rules the way production actually projects them.
   *
   * `PostgresRuleRepository.listPublic` reads the shared table with
   * `NULL::text AS target_id, platform AS scope_value`, so a signed manifest
   * import reaches its consumers with `scopeValue` set and NO `targetId`.
   * Keeping these rows out of `versions` (and out of `list()`) matters: when
   * this fixture seeded the signed rule as an ordinary workspace row carrying
   * `targetId`, every e2e test passed while the real public projection matched
   * no platform at all — which is how the production `rule.sync.status` came to
   * report `not_configured` after a successful import.
   */
  readonly publicVersions: PersistedRuleVersion[] = []

  async list(workspaceId: string, packId?: string) {
    return this.versions.filter(row => row.workspaceId === workspaceId && (!packId || row.packId === packId))
  }

  async listPublic(workspaceId: string, platform?: string) {
    return this.publicVersions.filter(row => row.workspaceId === workspaceId && (!platform || row.scopeValue === platform))
  }

  async insertVersion(input: Omit<PersistedRuleVersion, 'createdAt' | 'updatedAt'> & { createdAt?: string; updatedAt?: string }) {
    const row = { ...input, createdAt: input.createdAt ?? new Date().toISOString(), updatedAt: input.updatedAt ?? new Date().toISOString() } as PersistedRuleVersion
    this.versions.push(row)
    return row
  }

  async appendAudit(input: PersistedRuleAudit) { return input }
  async updateStatus(_input: { workspaceId: string; id: string; status: string; revision: number; updatedAt?: string; activatedAt?: string | null; deactivatedAt?: string | null }): Promise<PersistedRuleVersion> { throw new Error('not implemented') }
  async listAudit() { return [] }
}

export async function trustedPlatformRuleTestRepository(workspaceId: string, platform: RuleSyncPlatform) {
  const repository = new TrustedRuleTestRepository()
  for (const seed of defaultRuleCenterSeeds) {
    await repository.insertVersion({
      id: `${seed.packId}@${seed.version}`, workspaceId, packId: seed.packId, name: seed.name, version: seed.version,
      scope: seed.scope, status: seed.status ?? 'active', sourceKind: seed.source.kind, sourceReference: seed.source.reference,
      sourceCheckedAt: seed.source.checkedAt, checksum: createHash('sha256').update(`${seed.packId}:${seed.version}`).digest('hex'),
      checks: { ...(seed.checks ?? {}) } as Record<string, unknown>, createdBy: seed.createdBy ?? 'system', revision: 1,
      ...(seed.targetId ? { targetId: seed.targetId } : {}), ...(seed.scopeValue ? { scopeValue: seed.scopeValue } : {}),
      ...(seed.effectiveFrom ? { effectiveFrom: seed.effectiveFrom } : {}), ...(seed.effectiveTo ? { effectiveTo: seed.effectiveTo } : {}),
      ...(seed.severity ? { severity: seed.severity } : {}), ...(seed.action ? { action: seed.action } : {}),
    })
  }
  // The signed manifest import lands in the shared platform table, so it is
  // modelled with the public projection: no `targetId`, platform carried in
  // `scopeValue`. It is deliberately NOT pushed through `insertVersion`, which
  // would make it a workspace row again and hide the projection mismatch.
  repository.publicVersions.push({
    id: `signed-${workspaceId}-${platform}`, workspaceId, packId: `${platform}-signed`, name: `${platform} signed rule`, version: '2026.09.08',
    scope: 'platform', scopeValue: platform, status: 'active', sourceKind: 'official',
    sourceReference: PLATFORM_RULE_SOURCES.find(source => source.platform === platform)!.officialUrl,
    sourceCheckedAt: new Date().toISOString(), checksum: 'a'.repeat(64), checks: {}, createdBy: 'signed-rule-sync', revision: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  })
  return repository
}
