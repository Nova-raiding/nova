import { createHash } from 'node:crypto'

export type RulePackScope = 'global' | 'platform' | 'category' | 'brand' | 'store' | 'campaign'
export type RulePackStatus = 'draft' | 'active' | 'inactive' | 'expired'
export type RuleAuditAction = 'created' | 'activated' | 'deactivated' | 'expired'
export type RuleSeverity = 'error' | 'warning'
export type RuleAction = 'block' | 'warn' | 'review' | 'allow'

export interface RuleEvaluationContext {
  platform?: string
  category?: string
  brand?: string
  store?: string
  campaign?: string
}

export interface RuleSource {
  kind: 'official' | 'internal' | 'legal_review'
  reference: string
  checkedAt: string
}

export interface RuleChecks {
  forbiddenTerms?: string[]
  requiredFields?: string[]
  /** Stable domain key for policies that cannot be represented as a term or field. */
  conflictKeys?: string[]
}

/** Immutable, auditable version of a rule pack. The version is never edited in place. */
export interface RulePackVersion {
  id: string
  packId: string
  name: string
  version: string
  scope: RulePackScope
  status: RulePackStatus
  source: RuleSource
  checksum: string
  checks: RuleChecks
  createdAt: string
  updatedAt: string
  createdBy: string
  revision: number
  effectiveFrom?: string
  effectiveTo?: string
  severity?: RuleSeverity
  action?: RuleAction
  targetId?: string
  /** Compatibility alias used by some rule imports. */
  scopeValue?: string
  activatedAt?: string
  deactivatedAt?: string
}

/** Public list projection; it deliberately excludes executable rule details. */
export interface RulePack {
  id: string
  name: string
  version: string
  scope: RulePackScope
  status: RulePackStatus
  updatedAt: string
  source: RuleSource
  checksum: string
  revision: number
  effectiveFrom?: string
  effectiveTo?: string
  severity?: RuleSeverity
  action?: RuleAction
  targetId?: string
  scopeValue?: string
  activatedAt?: string
  deactivatedAt?: string
}

export interface RuleAuditEvent {
  id: string
  rulePackId: string
  ruleVersionId: string
  version: string
  action: RuleAuditAction
  actorId: string
  reason?: string
  at: string
}

export interface RuleCenterSeed {
  packId: string
  name: string
  version: string
  scope: RulePackScope
  status?: RulePackStatus
  source: RuleSource
  checks?: RuleChecks
  createdAt?: string
  createdBy?: string
  effectiveFrom?: string
  effectiveTo?: string
  severity?: RuleSeverity
  action?: RuleAction
  targetId?: string
  scopeValue?: string
}

export interface RuleEvaluationFinding {
  code: 'RULE_EXPIRED' | 'RULE_NOT_YET_EFFECTIVE' | 'RULE_PRIORITY_CONFLICT'
  severity: RuleSeverity
  action: RuleAction
  field: 'rules'
  ruleVersionId: string
  message: string
}

export interface RuleHit {
  ruleVersionId: string
  version: string
  scope: RulePackScope
  action: RuleAction
  severity: RuleSeverity
  matchedChecks: string[]
}

export interface RuleEvaluation {
  /** Applicable rules are ordered from broadest to most specific scope. */
  applicable: RulePackVersion[]
  checks: RuleChecks
  findings: RuleEvaluationFinding[]
  hits: RuleHit[]
}

const clone = <T>(value: T): T => structuredClone(value)

function normalizeConflictValue(value: string) {
  return value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN').replace(/\s+/gu, ' ')
}

function conflictKeys(checks: RuleChecks) {
  return new Set([
    ...(checks.forbiddenTerms ?? []).map(value => `term:${normalizeConflictValue(value)}`),
    ...(checks.requiredFields ?? []).map(value => `field:${normalizeConflictValue(value)}`),
    ...(checks.conflictKeys ?? []).map(value => `conflict:${normalizeConflictValue(value)}`),
  ])
}

function intersectConflictKeys(higher: RuleChecks, lower: RuleChecks) {
  const higherKeys = conflictKeys(higher)
  return [...conflictKeys(lower)].filter(key => higherKeys.has(key)).sort()
}

function expirationPolicy(rule: Pick<RulePackVersion, 'scope' | 'severity' | 'action'>): Pick<RuleEvaluationFinding, 'severity' | 'action'> {
  // A stale platform policy makes platform compliance unknowable, so the P0
  // boundary remains fail-closed even if the imported rule was advisory.
  if (rule.scope === 'platform') return { severity: 'error', action: 'block' }
  const configuredAction = rule.action ?? 'block'
  const blocking = rule.severity === 'error' || configuredAction === 'block'
  return { severity: blocking ? 'error' : 'warning', action: blocking ? 'block' : configuredAction }
}

/**
 * Small rule registry used by the application layer.
 *
 * The external API is intentionally read-only for now. Administrative callers
 * can use the explicit publish/status methods, which enforce immutable versions
 * and leave an audit event for every state change.
 */
export class RuleCenter {
  private readonly versions = new Map<string, RulePackVersion[]>()
  private readonly audits: RuleAuditEvent[] = []
  private sequence = 0

  constructor(private readonly clock: () => string = () => new Date().toISOString(), seeds: readonly RuleCenterSeed[] = []) {
    for (const seed of seeds) this.seed(seed)
  }

  private nextAuditId() {
    this.sequence += 1
    return `rule_audit_${this.sequence}`
  }

  private versionId(packId: string, version: string) { return `${packId}@${version}` }

  private checksum(seed: Pick<RuleCenterSeed, 'packId' | 'version' | 'scope' | 'source' | 'checks'>) {
    return createHash('sha256').update(JSON.stringify(seed)).digest('hex')
  }

  private validate(seed: RuleCenterSeed) {
    if (!seed.packId.trim() || !seed.name.trim() || !seed.version.trim() || !seed.source.reference.trim()) throw new Error('RULE_VERSION_INVALID')
    if (!seed.source.checkedAt) throw new Error('RULE_SOURCE_CHECK_REQUIRED')
    for (const term of seed.checks?.forbiddenTerms ?? []) if (!term.trim()) throw new Error('RULE_CHECK_INVALID')
    for (const field of seed.checks?.requiredFields ?? []) if (!field.trim()) throw new Error('RULE_CHECK_INVALID')
    for (const key of seed.checks?.conflictKeys ?? []) if (!key.trim()) throw new Error('RULE_CHECK_INVALID')
  }

  private seed(seed: RuleCenterSeed) {
    this.validate(seed)
    const at = seed.createdAt ?? this.clock()
    const version: RulePackVersion = {
      id: this.versionId(seed.packId, seed.version), packId: seed.packId, name: seed.name, version: seed.version,
      scope: seed.scope, status: seed.status ?? 'draft', source: clone(seed.source), checksum: this.checksum(seed),
      checks: clone(seed.checks ?? {}), createdAt: at, updatedAt: at, createdBy: seed.createdBy ?? 'system', revision: 1,
      ...(seed.effectiveFrom ? { effectiveFrom: seed.effectiveFrom } : {}),
      ...(seed.effectiveTo ? { effectiveTo: seed.effectiveTo } : {}),
      ...(seed.severity ? { severity: seed.severity } : {}),
      ...(seed.action ? { action: seed.action } : {}),
      ...(seed.targetId ? { targetId: seed.targetId } : {}),
      ...(seed.scopeValue ? { scopeValue: seed.scopeValue } : {}),
      ...(seed.status === 'active' ? { activatedAt: at } : {}),
    }
    const siblings = this.versions.get(seed.packId) ?? []
    if (siblings.some(item => item.version === seed.version)) throw new Error('RULE_VERSION_DUPLICATE')
    if (version.status === 'active' && siblings.some(item => item.status === 'active')) throw new Error('RULE_ACTIVE_VERSION_CONFLICT')
    siblings.push(version)
    this.versions.set(seed.packId, siblings)
    this.audits.push({ id: this.nextAuditId(), rulePackId: seed.packId, ruleVersionId: version.id, version: version.version, action: 'created', actorId: version.createdBy, at })
    if (version.status === 'active') this.audits.push({ id: this.nextAuditId(), rulePackId: seed.packId, ruleVersionId: version.id, version: version.version, action: 'activated', actorId: version.createdBy, at })
  }

  private latest(packId: string, version?: string) {
    const items = this.versions.get(packId) ?? []
    const found = version ? items.find(item => item.version === version) : items[items.length - 1]
    if (!found) throw new Error('RULE_VERSION_NOT_FOUND')
    return found
  }

  private projection(version: RulePackVersion): RulePack {
    const { id, name, version: versionName, scope, status, updatedAt, source, checksum, revision, effectiveFrom, effectiveTo, severity, action, targetId, scopeValue, activatedAt, deactivatedAt } = version
    return { id, name, version: versionName, scope, status, updatedAt, source: clone(source), checksum, revision,
      ...(effectiveFrom ? { effectiveFrom } : {}), ...(effectiveTo ? { effectiveTo } : {}), ...(severity ? { severity } : {}), ...(action ? { action } : {}),
      ...(targetId ? { targetId } : {}), ...(scopeValue ? { scopeValue } : {}), ...(activatedAt ? { activatedAt } : {}), ...(deactivatedAt ? { deactivatedAt } : {}) }
  }

  list(options: { includeInactive?: boolean } = {}): RulePack[] {
    const result: RulePack[] = []
    for (const items of this.versions.values()) {
      for (const item of items) if (options.includeInactive || item.status === 'active') result.push(this.projection(item))
    }
    return result.sort((left, right) => left.id.localeCompare(right.id))
  }

  history(packId: string): RulePack[] {
    // The registry preserves immutable creation order; revision is the number
    // of changes to one version, not a cross-version ordering key.
    return (this.versions.get(packId) ?? []).map(item => this.projection(item))
  }

  get(packId: string, version?: string): RulePack {
    return this.projection(this.latest(packId, version))
  }

  activeVersionIds(): string[] {
    return [...this.versions.values()].flatMap(items => items.filter(item => item.status === 'active').map(item => item.version))
  }

  activeChecks(): RuleChecks {
    const terms = new Set<string>(); const required = new Set<string>(); const conflictKeys = new Set<string>()
    for (const items of this.versions.values()) for (const item of items) if (item.status === 'active') {
      for (const term of item.checks.forbiddenTerms ?? []) terms.add(term)
      for (const field of item.checks.requiredFields ?? []) required.add(field)
      for (const key of item.checks.conflictKeys ?? []) conflictKeys.add(key)
    }
    return { forbiddenTerms: [...terms], requiredFields: [...required], ...(conflictKeys.size ? { conflictKeys: [...conflictKeys] } : {}) }
  }

  /**
   * Resolves active rules from broad to specific scope and evaluates their
   * validity window. Existing callers can continue using activeChecks(); this
   * method is the opt-in context-aware path for reviews.
   */
  evaluate(context: RuleEvaluationContext = {}, at = this.clock()): RuleEvaluation {
    const now = Date.parse(at)
    if (Number.isNaN(now)) throw new Error('RULE_EVALUATION_TIME_INVALID')
    const scopeOrder: RulePackScope[] = ['global', 'platform', 'category', 'brand', 'store', 'campaign']
    const applicable: RulePackVersion[] = []
    const findings: RuleEvaluationFinding[] = []
    for (const scope of scopeOrder) {
      for (const items of this.versions.values()) {
        for (const item of items.filter(candidate => (candidate.status === 'active' || candidate.status === 'expired') && candidate.scope === scope)) {
          const target = item.targetId ?? item.scopeValue
          const expected = scope === 'global' ? undefined : context[scope]
          if (scope !== 'global' && (!expected || (target && target !== expected) || !target)) continue
          if (item.status === 'expired') {
            const policy = expirationPolicy(item)
            findings.push({ code: 'RULE_EXPIRED', ...policy, field: 'rules', ruleVersionId: item.id, message: `规则 ${item.version} 已标记为过期，不能用于本次审核` })
            continue
          }
          const from = item.effectiveFrom ? Date.parse(item.effectiveFrom) : Number.NEGATIVE_INFINITY
          const to = item.effectiveTo ? Date.parse(item.effectiveTo) : Number.POSITIVE_INFINITY
          if ((item.effectiveFrom && Number.isNaN(from)) || (item.effectiveTo && Number.isNaN(to))) continue
          if (now < from) {
            findings.push({ code: 'RULE_NOT_YET_EFFECTIVE', severity: item.severity ?? 'error', action: item.action ?? 'block', field: 'rules', ruleVersionId: item.id, message: `规则 ${item.version} 尚未到生效时间 ${item.effectiveFrom}` })
            continue
          }
          if (now >= to) {
            const policy = expirationPolicy(item)
            findings.push({ code: 'RULE_EXPIRED', ...policy, field: 'rules', ruleVersionId: item.id, message: `规则 ${item.version} 已于 ${item.effectiveTo} 过期，不能用于本次审核` })
            continue
          }
          applicable.push(clone(item))
        }
      }
    }
    for (let higherIndex = 0; higherIndex < applicable.length; higherIndex += 1) {
      const higher = applicable[higherIndex]!
      for (let lowerIndex = higherIndex + 1; lowerIndex < applicable.length; lowerIndex += 1) {
        const lower = applicable[lowerIndex]!
        if (higher.scope === lower.scope || (higher.action ?? 'block') !== 'block' || lower.action !== 'allow') continue
        const sharedKeys = intersectConflictKeys(higher.checks, lower.checks)
        if (sharedKeys.length) findings.push({ code: 'RULE_PRIORITY_CONFLICT', severity: 'error', action: 'block', field: 'rules', ruleVersionId: lower.id, message: `低优先级规则 ${lower.version} 不能覆盖 ${higher.scope} 范围的硬阻断规则 ${higher.version}（冲突键：${sharedKeys.join('、')}）` })
      }
    }
    const terms = new Set<string>(); const required = new Set<string>(); const conflictKeys = new Set<string>()
    const hits: RuleHit[] = []
    for (const item of applicable) {
      for (const term of item.checks.forbiddenTerms ?? []) terms.add(term)
      for (const field of item.checks.requiredFields ?? []) required.add(field)
      for (const key of item.checks.conflictKeys ?? []) conflictKeys.add(key)
      hits.push({ ruleVersionId: item.id, version: item.version, scope: item.scope, action: item.action ?? 'block', severity: item.severity ?? 'error', matchedChecks: [...(item.checks.forbiddenTerms ?? []).map(() => 'forbiddenTerms'), ...(item.checks.requiredFields ?? []).map(() => 'requiredFields'), ...(item.checks.conflictKeys ?? []).map(() => 'conflictKeys')] })
    }
    return { applicable, checks: { forbiddenTerms: [...terms], requiredFields: [...required], ...(conflictKeys.size ? { conflictKeys: [...conflictKeys] } : {}) }, findings, hits }
  }

  publish(input: Omit<RuleCenterSeed, 'status'> & { actorId: string; reason?: string }): RulePack {
    this.validate(input)
    const siblings = this.versions.get(input.packId) ?? []
    if (siblings.some(item => item.version === input.version)) throw new Error('RULE_VERSION_DUPLICATE')
    const at = this.clock()
    const version: RulePackVersion = {
      id: this.versionId(input.packId, input.version), packId: input.packId, name: input.name, version: input.version,
      scope: input.scope, status: 'draft', source: clone(input.source), checksum: this.checksum(input), checks: clone(input.checks ?? {}),
      createdAt: at, updatedAt: at, createdBy: input.actorId, revision: 1,
      ...(input.effectiveFrom ? { effectiveFrom: input.effectiveFrom } : {}),
      ...(input.effectiveTo ? { effectiveTo: input.effectiveTo } : {}),
      ...(input.severity ? { severity: input.severity } : {}),
      ...(input.action ? { action: input.action } : {}),
      ...(input.targetId ? { targetId: input.targetId } : {}),
      ...(input.scopeValue ? { scopeValue: input.scopeValue } : {}),
    }
    siblings.push(version); this.versions.set(input.packId, siblings)
    this.audits.push({ id: this.nextAuditId(), rulePackId: input.packId, ruleVersionId: version.id, version: version.version, action: 'created', actorId: input.actorId, ...(input.reason ? { reason: input.reason } : {}), at })
    return this.projection(version)
  }

  setStatus(input: { packId: string; version?: string; status: 'active' | 'inactive' | 'expired'; actorId: string; reason: string }): RulePack {
    if (!input.reason.trim()) throw new Error('RULE_STATUS_REASON_REQUIRED')
    const target = this.latest(input.packId, input.version)
    if (target.status === input.status) return this.projection(target)
    const at = this.clock()
    if (input.status === 'active') {
      const current = (this.versions.get(input.packId) ?? []).find(item => item.status === 'active')
      if (current && current.id !== target.id) {
        current.status = 'inactive'; current.deactivatedAt = at; current.updatedAt = at; current.revision += 1
        this.audits.push({ id: this.nextAuditId(), rulePackId: input.packId, ruleVersionId: current.id, version: current.version, action: 'deactivated', actorId: input.actorId, reason: input.reason, at })
      }
      target.activatedAt = at
      this.audits.push({ id: this.nextAuditId(), rulePackId: input.packId, ruleVersionId: target.id, version: target.version, action: 'activated', actorId: input.actorId, reason: input.reason, at })
    } else {
      this.audits.push({ id: this.nextAuditId(), rulePackId: input.packId, ruleVersionId: target.id, version: target.version, action: input.status === 'expired' ? 'expired' : 'deactivated', actorId: input.actorId, reason: input.reason, at })
      target.deactivatedAt = at
    }
    target.status = input.status; target.updatedAt = at; target.revision += 1
    return this.projection(target)
  }

  audit(packId?: string): RuleAuditEvent[] {
    return this.audits.filter(event => !packId || event.rulePackId === packId).map(event => clone(event))
  }
}

export const defaultRuleCenterSeeds: readonly RuleCenterSeed[] = [
  { packId: 'cn-commerce', name: '中国电商广告表达', version: 'cn-commerce-1.0.0', scope: 'global', status: 'active', source: { kind: 'official', reference: 'manual://cn-commerce-advertising', checkedAt: '2026-08-22T00:00:00.000Z' }, checks: { forbiddenTerms: ['最强', '第一', '绝对化'] }, createdAt: '2026-08-22T00:00:00.000Z' },
  { packId: 'apparel-facts', name: '服装鞋包事实完整性', version: 'apparel-1.0.0', scope: 'category', status: 'active', source: { kind: 'internal', reference: 'manual://apparel-facts', checkedAt: '2026-08-20T00:00:00.000Z' }, createdAt: '2026-08-20T00:00:00.000Z' },
  { packId: 'tmall-mapping', name: '淘宝/天猫字段映射', version: 'tmall-apparel-1.0.0', scope: 'platform', targetId: 'tmall', status: 'active', source: { kind: 'official', reference: 'manual://tmall-mapping', checkedAt: '2026-08-17T00:00:00.000Z' }, createdAt: '2026-08-17T00:00:00.000Z' },
  { packId: 'taobao-mapping', name: '淘宝字段映射', version: 'taobao-apparel-1.0.0', scope: 'platform', targetId: 'taobao', status: 'active', source: { kind: 'official', reference: 'manual://taobao-mapping', checkedAt: '2026-08-17T00:00:00.000Z' }, createdAt: '2026-08-17T00:00:00.000Z' },
  { packId: 'jd-write', name: '京东商品写入策略', version: 'jd-apparel-write-1.0.0', scope: 'platform', targetId: 'jd', status: 'active', source: { kind: 'official', reference: 'manual://jd-write', checkedAt: '2026-08-15T00:00:00.000Z' }, createdAt: '2026-08-15T00:00:00.000Z' },
  { packId: 'pinduoduo-mapping', name: '拼多多字段映射', version: 'pinduoduo-apparel-1.0.0', scope: 'platform', targetId: 'pinduoduo', status: 'active', source: { kind: 'official', reference: 'manual://pinduoduo-mapping', checkedAt: '2026-08-16T00:00:00.000Z' }, createdAt: '2026-08-16T00:00:00.000Z' },
  { packId: 'xiaohongshu-content', name: '小红书商品内容安全边界', version: 'xiaohongshu-content-1.0.0', scope: 'platform', targetId: 'xiaohongshu', status: 'active', source: { kind: 'internal', reference: 'manual://xiaohongshu-content-safety', checkedAt: '2026-08-26T00:00:00.000Z' }, checks: { forbiddenTerms: ['全网最低', '绝对第一', '百分百有效'] }, createdAt: '2026-08-26T00:00:00.000Z' },
  { packId: 'douyin-content', name: '抖音商品内容安全边界', version: 'douyin-content-1.0.0', scope: 'platform', targetId: 'douyin', status: 'active', source: { kind: 'internal', reference: 'manual://douyin-content-safety', checkedAt: '2026-08-26T00:00:00.000Z' }, checks: { forbiddenTerms: ['全网最低', '绝对第一', '百分百有效'] }, createdAt: '2026-08-26T00:00:00.000Z' },
]
