import { createHash } from 'node:crypto'
import { defaultRuleCenterSeeds } from '../../../packages/review/src/rule-center.js'
import { PLATFORM_RULE_SOURCES, type RuleSyncPlatform } from '../../../packages/review/src/platform-rule-sync.js'
import type { PersistedRuleAudit, PersistedRuleVersion } from '../../../packages/persistence/src/index.js'
import type { RuleRepositoryPort } from './server.js'

export class TrustedRuleTestRepository implements RuleRepositoryPort {
  readonly versions: PersistedRuleVersion[] = []

  async list(workspaceId: string, packId?: string) {
    return this.versions.filter(row => row.workspaceId === workspaceId && (!packId || row.packId === packId))
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
  await repository.insertVersion({
    id: `signed-${workspaceId}-${platform}`, workspaceId, packId: `${platform}-signed`, name: `${platform} signed rule`, version: '2026.09.08',
    scope: 'platform', targetId: platform, status: 'active', sourceKind: 'official',
    sourceReference: PLATFORM_RULE_SOURCES.find(source => source.platform === platform)!.officialUrl,
    sourceCheckedAt: new Date().toISOString(), checksum: 'a'.repeat(64), checks: {}, createdBy: 'signed-rule-sync', revision: 1,
  })
  return repository
}
