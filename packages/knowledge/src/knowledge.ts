export type RuleScope = 'global' | 'platform' | 'category' | 'brand' | 'store' | 'campaign'
export type RuleStatus = 'draft' | 'active' | 'inactive' | 'archived' | 'expired'
export type RuleSourceKind = 'official' | 'internal' | 'merchant' | 'observed' | 'legal_review'
export type RuleSeverity = 'info' | 'warning' | 'error'
export type RuleAction = 'warn' | 'block' | 'require_confirmation' | 'suggest'

export interface RuleSource {
  kind: RuleSourceKind
  reference: string
  checkedAt: string
}

export interface RuleTarget {
  platform?: string
  category?: string
  brand?: string
  store?: string
  campaign?: string
}

export interface RuleEntry {
  id: string
  /** Tenant scope for operator-managed knowledge rules. */
  workspaceId?: string
  name: string
  description?: string
  content: string
  scope: RuleScope
  scopeValue?: string
  target: RuleTarget
  source: RuleSource
  version: string
  severity: RuleSeverity
  action: RuleAction
  ownerId: string
  effectiveFrom?: string
  effectiveTo?: string
  status: RuleStatus
  tags: string[]
  revision: number
  createdAt: string
  updatedAt: string
}

export type RuleCreateInput = Omit<RuleEntry, 'id' | 'revision' | 'createdAt' | 'updatedAt' | 'target' | 'tags' | 'severity' | 'action' | 'ownerId'> & {
  target?: RuleTarget
  tags?: string[]
  severity?: RuleSeverity
  action?: RuleAction
  ownerId?: string
}

export type RuleUpdateInput = Partial<Pick<RuleEntry,
  'name' | 'description' | 'content' | 'scope' | 'scopeValue' | 'target' | 'source' |
  'version' | 'effectiveFrom' | 'effectiveTo' | 'status' | 'tags' | 'severity' | 'action' | 'ownerId'
>>

export interface RuleQuery {
  workspaceId?: string
  scope?: RuleScope
  scopeValue?: string
  status?: RuleStatus
  asOf?: string
  platform?: string
  category?: string
  brand?: string
  store?: string
  campaign?: string
  text?: string
}

export interface RuleContext extends RuleTarget {}

export type AssetKind = 'brand' | 'customer'
export type AssetApprovalStatus = 'pending' | 'approved' | 'rejected'
export type AssetRightsStatus = 'unknown' | 'cleared' | 'restricted'

export interface AssetEntry {
  id: string
  workspaceId: string
  kind: AssetKind
  name: string
  content: string | Record<string, unknown>
  source?: string
  tags: string[]
  approvalStatus: AssetApprovalStatus
  rightsStatus: AssetRightsStatus
  revision: number
  createdAt: string
  updatedAt: string
}

export type AssetCreateInput = Omit<AssetEntry, 'id' | 'revision' | 'createdAt' | 'updatedAt' | 'tags' | 'approvalStatus' | 'rightsStatus'> & {
  tags?: string[]
  approvalStatus?: AssetApprovalStatus
  rightsStatus?: AssetRightsStatus
}

export type AssetUpdateInput = Partial<Pick<AssetEntry, 'kind' | 'name' | 'content' | 'source' | 'tags' | 'approvalStatus' | 'rightsStatus'>>

export interface AssetQuery {
  workspaceId: string
  kind?: AssetKind
  text?: string
  tags?: string[]
}

export type FeedbackKind = 'feedback' | 'platform_rejection'

export interface FeedbackRecord {
  id: string
  workspaceId: string
  kind: FeedbackKind
  platform?: string
  contentId?: string
  reason: string
  details?: string
  metadata: Record<string, string>
  createdAt: string
}

export type FeedbackCreateInput = Omit<FeedbackRecord, 'id' | 'createdAt' | 'metadata'> & {
  metadata?: Record<string, string>
}

export type LearningSuggestionStatus = 'pending' | 'confirmed' | 'dismissed'

export interface LearningSuggestion {
  id: string
  workspaceId: string
  feedbackId: string
  status: LearningSuggestionStatus
  summary: string
  proposedRule: {
    content: string
    scope: RuleScope
    scopeValue?: string
    source: RuleSource
    version: string
    status: 'draft'
  }
  createdAt: string
  updatedAt: string
  confirmedAt?: string
  confirmedBy?: string
  confirmationNote?: string
}

export interface ConfirmLearningSuggestionInput {
  workspaceId: string
  suggestionId: string
  confirmedBy: string
  note?: string
}

export interface CompetitorSource {
  url: string
  title: string
  accessedAt: string
}

export interface CompetitorStructure {
  sections: string[]
  layout?: string[]
}

export interface CompetitorExpression {
  tone: string[]
  formats: string[]
  callsToAction?: string[]
}

/** Public competitor information is intentionally structured; raw copied text is not accepted. */
export interface CompetitorAnalysis {
  id: string
  workspaceId: string
  competitorName: string
  source: CompetitorSource
  summary: string
  structure: CompetitorStructure
  sellingPoints: string[]
  expression: CompetitorExpression
  createdAt: string
  updatedAt: string
}

export interface CompetitorCreateInput {
  workspaceId: string
  competitorName: string
  source: CompetitorSource
  /** A user-authored paraphrase, never the source's original copy. */
  summary: string
  structure: CompetitorStructure
  sellingPoints: string[]
  expression: CompetitorExpression
  /** Compile-time guard for the prohibited input shapes. */
  originalText?: never
  copiedText?: never
  copyBrand?: never
}

export type CompetitorUpdateInput = Partial<Pick<CompetitorCreateInput,
  'competitorName' | 'source' | 'summary' | 'structure' | 'sellingPoints' | 'expression'>> & {
  originalText?: never
  copiedText?: never
  copyBrand?: never
}

export interface CompetitorQuery {
  workspaceId: string
  competitorName?: string
  text?: string
}

export interface DifferentiationReference {
  competitorAnalysisId: string
  referenceMode: 'differentiation_only'
  structuralObservations: string[]
  expressionObservations: string[]
  differentiationAngles: string[]
  safeExpressionGuidance: string[]
  compliance: {
    originalTextCopied: false
    competitorBrandReused: false
  }
}

export interface DifferentiationReferenceInput {
  workspaceId: string
  competitorId: string
  ownSellingPoints: string[]
  ownBrandName: string
}

export class KnowledgeError extends Error {
  constructor(public readonly code: string, message = code) {
    super(message)
    this.name = 'KnowledgeError'
  }
}

export interface KnowledgeModuleOptions {
  clock?: () => string
  idFactory?: (prefix: string, sequence: number) => string
}

export interface KnowledgeEvent {
  /** Durable envelope metadata used to defend replay against a mis-scoped source. */
  id?: string
  workspaceId?: string
  aggregateId?: string
  sequence?: number
  createdAt?: string
  eventType: string
  payload: Record<string, unknown>
}

const clone = <T>(value: T): T => structuredClone(value)

const requiredText = (value: string | undefined, code: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new KnowledgeError(code)
  return value.trim()
}

const cleanList = (values: readonly string[] | undefined, code: string): string[] => {
  if (values === undefined) return []
  if (!Array.isArray(values)) throw new KnowledgeError(code)
  const result = [...new Set(values.map(value => requiredText(value, code)))]
  return result
}

const assertAssetEnums = (input: { kind?: string; approvalStatus?: string; rightsStatus?: string }): void => {
  if (input.kind !== undefined && !['brand', 'customer'].includes(input.kind)) throw new KnowledgeError('ASSET_KIND_INVALID')
  if (input.approvalStatus !== undefined && !['pending', 'approved', 'rejected'].includes(input.approvalStatus)) throw new KnowledgeError('ASSET_APPROVAL_STATUS_INVALID')
  if (input.rightsStatus !== undefined && !['unknown', 'cleared', 'restricted'].includes(input.rightsStatus)) throw new KnowledgeError('ASSET_RIGHTS_STATUS_INVALID')
}

const assertRuleEnums = (input: { scope?: string; status?: string; severity?: string; action?: string; source?: { kind?: string } }): void => {
  if (input.scope !== undefined && !['global', 'platform', 'category', 'brand', 'store', 'campaign'].includes(input.scope)) throw new KnowledgeError('RULE_SCOPE_INVALID')
  if (input.status !== undefined && !['draft', 'active', 'inactive', 'archived', 'expired'].includes(input.status)) throw new KnowledgeError('RULE_STATUS_INVALID')
  if (input.severity !== undefined && !['info', 'warning', 'error'].includes(input.severity)) throw new KnowledgeError('RULE_SEVERITY_INVALID')
  if (input.action !== undefined && !['warn', 'block', 'require_confirmation', 'suggest'].includes(input.action)) throw new KnowledgeError('RULE_ACTION_INVALID')
  if (input.source?.kind !== undefined && !['official', 'internal', 'merchant', 'observed', 'legal_review'].includes(input.source.kind)) throw new KnowledgeError('RULE_SOURCE_KIND_INVALID')
}

const validDate = (value: string | undefined, code: string): string | undefined => {
  if (value === undefined) return undefined
  requiredText(value, code)
  if (Number.isNaN(Date.parse(value))) throw new KnowledgeError(code)
  return value
}

const normalizeTarget = (scope: RuleScope, scopeValue: string | undefined, target: RuleTarget | undefined): RuleTarget => {
  const normalized = { ...(target ?? {}) }
  if (scope === 'global') {
    if (scopeValue || Object.values(normalized).some(Boolean)) throw new KnowledgeError('RULE_TARGET_NOT_ALLOWED')
    return {}
  }
  const key: keyof RuleTarget = scope
  const value = scopeValue ?? normalized[key]
  requiredText(value, 'RULE_SCOPE_VALUE_REQUIRED')
  if (normalized[key] && normalized[key] !== value) throw new KnowledgeError('RULE_SCOPE_TARGET_CONFLICT')
  return { ...normalized, [key]: value }
}

const matchesAt = (rule: RuleEntry, at: string): boolean => {
  const timestamp = Date.parse(at)
  if (Number.isNaN(timestamp)) throw new KnowledgeError('RULE_AS_OF_INVALID')
  const from = rule.effectiveFrom ? Date.parse(rule.effectiveFrom) : Number.NEGATIVE_INFINITY
  const to = rule.effectiveTo ? Date.parse(rule.effectiveTo) : Number.POSITIVE_INFINITY
  return rule.status === 'active' && timestamp >= from && timestamp <= to
}

const scopeRank: Record<RuleScope, number> = {
  global: 0,
  platform: 1,
  category: 2,
  brand: 3,
  store: 4,
  campaign: 5,
}

const matchesContext = (rule: RuleEntry, context: RuleContext): boolean => {
  if (rule.scope === 'global') return true
  const value = rule.target[rule.scope]
  return Boolean(value && context[rule.scope] === value)
}

const containsText = (values: readonly string[], text: string): boolean => values.some(value => value.toLocaleLowerCase().includes(text))

const forbiddenCompetitorKeys = new Set(['originalText', 'copiedText', 'copyBrand', 'exactCopy', 'verbatimText'])

function assertCompetitorInput(input: object): void {
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    for (const [key, nested] of Object.entries(value)) {
      if (forbiddenCompetitorKeys.has(key)) throw new KnowledgeError('COMPETITOR_COPY_INPUT_FORBIDDEN')
      visit(nested)
    }
  }
  visit(input)
}

const normalizeStructure = (structure: CompetitorStructure): CompetitorStructure => ({
  sections: cleanList(structure?.sections, 'COMPETITOR_STRUCTURE_INVALID'),
  ...(structure?.layout ? { layout: cleanList(structure.layout, 'COMPETITOR_STRUCTURE_INVALID') } : {}),
})

const normalizeExpression = (expression: CompetitorExpression): CompetitorExpression => ({
  tone: cleanList(expression?.tone, 'COMPETITOR_EXPRESSION_INVALID'),
  formats: cleanList(expression?.formats, 'COMPETITOR_EXPRESSION_INVALID'),
  ...(expression?.callsToAction ? { callsToAction: cleanList(expression.callsToAction, 'COMPETITOR_EXPRESSION_INVALID') } : {}),
})

/**
 * An in-memory, workspace-aware knowledge domain module.
 * Persistence adapters can be added later without changing these domain contracts.
 */
export class KnowledgeModule {
  private readonly clock: () => string
  private readonly idFactory: (prefix: string, sequence: number) => string
  private sequence = 0
  private readonly rules = new Map<string, RuleEntry>()
  private readonly assets = new Map<string, AssetEntry>()
  private readonly feedback = new Map<string, FeedbackRecord>()
  private readonly suggestions = new Map<string, LearningSuggestion>()
  private readonly competitors = new Map<string, CompetitorAnalysis>()
  private readonly hydratedSequences = new Map<string, number>()

  constructor(options: KnowledgeModuleOptions = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString())
    this.idFactory = options.idFactory ?? ((prefix, sequence) => `${prefix}_${sequence}`)
  }

  private now(): string { return this.clock() }

  private nextId(prefix: string): string {
    this.sequence += 1
    return this.idFactory(prefix, this.sequence)
  }

  /** Rebuild knowledge state from append-only events after an API restart. */
  hydrate(events: readonly KnowledgeEvent[]): void {
    for (const event of events) {
      const known = new Set(['knowledge.rule.created', 'knowledge.asset.created', 'knowledge.asset.updated', 'knowledge.competitor.created', 'knowledge.feedback.recorded', 'knowledge.learning.confirmed', 'knowledge.learning.dismissed', 'task_feedback_submitted', 'publish.observation'])
      if (!known.has(event.eventType)) throw new KnowledgeError('KNOWLEDGE_EVENT_UNKNOWN', `unsupported knowledge event: ${event.eventType}`)
      if (event.aggregateId && event.sequence !== undefined) {
        if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) throw new KnowledgeError('KNOWLEDGE_EVENT_SEQUENCE_INVALID')
        const previous = this.hydratedSequences.get(event.aggregateId)
        if (previous !== undefined && event.sequence <= previous) throw new KnowledgeError('KNOWLEDGE_EVENT_SEQUENCE_OUT_OF_ORDER')
        this.hydratedSequences.set(event.aggregateId, event.sequence)
      }
      const payload = event.payload
      const id = typeof payload.id === 'string' ? payload.id : undefined
      if (id) {
        const match = id.match(/[-_:](\d+)$/u)
        if (match) this.sequence = Math.max(this.sequence, Number(match[1]))
      }
      if (event.eventType === 'knowledge.rule.created' && id) this.rules.set(id, clone(payload as unknown as RuleEntry))
      if ((event.eventType === 'knowledge.asset.created' || event.eventType === 'knowledge.asset.updated') && id) this.assets.set(id, clone(payload as unknown as AssetEntry))
      if (event.eventType === 'knowledge.competitor.created' && id) this.competitors.set(id, clone(payload as unknown as CompetitorAnalysis))
      if (event.eventType === 'knowledge.feedback.recorded' && id) {
        const feedback = clone(payload as unknown as FeedbackRecord)
        this.feedback.set(id, feedback)
        if (![...this.suggestions.values()].some(item => item.feedbackId === id)) this.createSuggestion(feedback)
      }
      if ((event.eventType === 'knowledge.learning.confirmed' || event.eventType === 'knowledge.learning.dismissed') && id) this.suggestions.set(id, clone(payload as unknown as LearningSuggestion))
      const observed = payload.knowledge_observation
      if ((event.eventType === 'task_feedback_submitted' || event.eventType === 'publish.observation') && observed && typeof observed === 'object' && !Array.isArray(observed)) {
        const item = observed as Record<string, unknown>
        if (typeof item.workspaceId === 'string' && typeof item.sourceKey === 'string' && (item.kind === 'feedback' || item.kind === 'platform_rejection') && typeof item.reason === 'string') {
          this.recordObservedFeedback({ workspaceId: item.workspaceId, sourceKey: item.sourceKey, kind: item.kind, reason: item.reason, ...(typeof item.platform === 'string' ? { platform: item.platform } : {}), ...(typeof item.contentId === 'string' ? { contentId: item.contentId } : {}), ...(typeof item.details === 'string' ? { details: item.details } : {}), ...(item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata) ? { metadata: item.metadata as Record<string, string> } : {}), ...(typeof item.createdAt === 'string' ? { createdAt: item.createdAt } : {}) })
        }
      }
    }
  }

  private assertRuleDates(from: string | undefined, to: string | undefined): void {
    const effectiveFrom = validDate(from, 'RULE_EFFECTIVE_WINDOW_INVALID')
    const effectiveTo = validDate(to, 'RULE_EFFECTIVE_WINDOW_INVALID')
    if (effectiveFrom && effectiveTo && Date.parse(effectiveTo) < Date.parse(effectiveFrom)) throw new KnowledgeError('RULE_EFFECTIVE_WINDOW_INVALID')
  }

  createRule(input: RuleCreateInput): RuleEntry {
    const now = this.now()
    assertRuleEnums(input)
    const workspaceId = input.workspaceId ? requiredText(input.workspaceId, 'WORKSPACE_REQUIRED') : undefined
    const name = requiredText(input.name, 'RULE_NAME_REQUIRED')
    const content = requiredText(input.content, 'RULE_CONTENT_REQUIRED')
    const scope = input.scope
    const target = normalizeTarget(scope, input.scopeValue, input.target)
    const effectiveFrom = validDate(input.effectiveFrom, 'RULE_EFFECTIVE_WINDOW_INVALID')
    const effectiveTo = validDate(input.effectiveTo, 'RULE_EFFECTIVE_WINDOW_INVALID')
    this.assertRuleDates(effectiveFrom, effectiveTo)
    const source = {
      kind: input.source.kind,
      reference: requiredText(input.source.reference, 'RULE_SOURCE_REQUIRED'),
      checkedAt: requiredText(input.source.checkedAt, 'RULE_SOURCE_REQUIRED'),
    }
    validDate(source.checkedAt, 'RULE_SOURCE_INVALID')
    const rule: RuleEntry = {
      id: this.nextId('rule'), ...(workspaceId ? { workspaceId } : {}), name, content, scope, target, source,
      ...(input.description ? { description: input.description.trim() } : {}),
      ...(input.scopeValue ? { scopeValue: input.scopeValue.trim() } : {}),
      version: requiredText(input.version, 'RULE_VERSION_REQUIRED'),
      severity: input.severity ?? 'warning', action: input.action ?? 'require_confirmation', ownerId: requiredText(input.ownerId ?? 'unassigned', 'RULE_OWNER_REQUIRED'),
      ...(effectiveFrom ? { effectiveFrom } : {}), ...(effectiveTo ? { effectiveTo } : {}),
      status: input.status, tags: cleanList(input.tags, 'RULE_TAG_INVALID'), revision: 1,
      createdAt: now, updatedAt: now,
    }
    this.rules.set(rule.id, rule)
    return clone(rule)
  }

  getRule(id: string): RuleEntry | undefined { const rule = this.rules.get(id); return rule ? clone(rule) : undefined }

  updateRule(id: string, patch: RuleUpdateInput): RuleEntry {
    const current = this.rules.get(id)
    if (!current) throw new KnowledgeError('RULE_NOT_FOUND')
    assertRuleEnums(patch)
    const nextScope = patch.scope ?? current.scope
    const scopeValue = patch.scopeValue ?? (patch.scope ? undefined : current.scopeValue)
    const target = normalizeTarget(nextScope, scopeValue, patch.target ?? (patch.scope ? undefined : current.target))
    const effectiveFrom = validDate(patch.effectiveFrom ?? current.effectiveFrom, 'RULE_EFFECTIVE_WINDOW_INVALID')
    const effectiveTo = validDate(patch.effectiveTo ?? current.effectiveTo, 'RULE_EFFECTIVE_WINDOW_INVALID')
    this.assertRuleDates(effectiveFrom, effectiveTo)
    const next: RuleEntry = {
      ...current,
      ...(patch.name !== undefined ? { name: requiredText(patch.name, 'RULE_NAME_REQUIRED') } : {}),
      ...(patch.description !== undefined ? { description: patch.description?.trim() } : {}),
      ...(patch.content !== undefined ? { content: requiredText(patch.content, 'RULE_CONTENT_REQUIRED') } : {}),
      scope: nextScope, target,
      ...(scopeValue ? { scopeValue } : {}),
      ...(nextScope === 'global' ? { scopeValue: undefined } : {}),
      ...(patch.source ? { source: { ...patch.source, reference: requiredText(patch.source.reference, 'RULE_SOURCE_REQUIRED'), checkedAt: requiredText(patch.source.checkedAt, 'RULE_SOURCE_REQUIRED') } } : {}),
      ...(patch.version !== undefined ? { version: requiredText(patch.version, 'RULE_VERSION_REQUIRED') } : {}),
      ...(effectiveFrom ? { effectiveFrom } : { effectiveFrom: undefined }),
      ...(effectiveTo ? { effectiveTo } : { effectiveTo: undefined }),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.severity !== undefined ? { severity: patch.severity } : {}),
      ...(patch.action !== undefined ? { action: patch.action } : {}),
      ...(patch.ownerId !== undefined ? { ownerId: requiredText(patch.ownerId, 'RULE_OWNER_REQUIRED') } : {}),
      ...(patch.tags !== undefined ? { tags: cleanList(patch.tags, 'RULE_TAG_INVALID') } : {}),
      revision: current.revision + 1, updatedAt: this.now(),
    }
    if (patch.source) validDate(next.source.checkedAt, 'RULE_SOURCE_INVALID')
    this.rules.set(id, next)
    return clone(next)
  }

  deleteRule(id: string): void {
    if (!this.rules.delete(id)) throw new KnowledgeError('RULE_NOT_FOUND')
  }

  queryRules(query: RuleQuery = {}): RuleEntry[] {
    const workspaceId = query.workspaceId?.trim()
    if (query.workspaceId !== undefined && !workspaceId) throw new KnowledgeError('WORKSPACE_REQUIRED')
    const text = query.text?.trim().toLocaleLowerCase()
    return [...this.rules.values()].filter(rule => {
      if (workspaceId && rule.workspaceId !== workspaceId) return false
      if (query.scope && rule.scope !== query.scope) return false
      if (query.scopeValue && rule.scopeValue !== query.scopeValue) return false
      if (query.status && rule.status !== query.status) return false
      if (query.asOf && !matchesAt(rule, query.asOf)) return false
      for (const key of ['platform', 'category', 'brand', 'store', 'campaign'] as const) if (query[key] && rule.target[key] !== query[key]) return false
      if (text && ![rule.name, rule.content, rule.description ?? '', ...rule.tags].some(value => value.toLocaleLowerCase().includes(text))) return false
      return true
    }).sort((left, right) => scopeRank[left.scope] - scopeRank[right.scope] || left.id.localeCompare(right.id)).map(clone)
  }

  listRules(query: RuleQuery = {}): RuleEntry[] { return this.queryRules(query) }

  findApplicableRules(context: RuleContext, asOf: string, workspaceId?: string): RuleEntry[] {
    const scope = workspaceId?.trim()
    if (workspaceId !== undefined && !scope) throw new KnowledgeError('WORKSPACE_REQUIRED')
    return this.queryRules({ asOf })
      .filter(rule => !scope || rule.workspaceId === undefined || rule.workspaceId === scope)
      .filter(rule => matchesContext(rule, context))
      .sort((left, right) => scopeRank[right.scope] - scopeRank[left.scope])
      .map(clone)
  }

  createAsset(input: AssetCreateInput): AssetEntry {
    const workspaceId = requiredText(input.workspaceId, 'WORKSPACE_REQUIRED')
    assertAssetEnums(input)
    const now = this.now()
    const asset: AssetEntry = {
      id: this.nextId('asset'), workspaceId, kind: input.kind,
      name: requiredText(input.name, 'ASSET_NAME_REQUIRED'), content: clone(input.content),
      ...(input.source ? { source: input.source.trim() } : {}), tags: cleanList(input.tags, 'ASSET_TAG_INVALID'),
      approvalStatus: input.approvalStatus ?? 'pending', rightsStatus: input.rightsStatus ?? 'unknown',
      revision: 1, createdAt: now, updatedAt: now,
    }
    this.assets.set(asset.id, asset)
    return clone(asset)
  }

  getAsset(workspaceId: string, id: string): AssetEntry | undefined {
    const asset = this.assets.get(id)
    return asset?.workspaceId === workspaceId ? clone(asset) : undefined
  }

  updateAsset(workspaceId: string, id: string, patch: AssetUpdateInput): AssetEntry {
    const current = this.assets.get(id)
    if (!current || current.workspaceId !== workspaceId) throw new KnowledgeError('ASSET_NOT_FOUND')
    assertAssetEnums(patch)
    const next: AssetEntry = {
      ...current,
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.name !== undefined ? { name: requiredText(patch.name, 'ASSET_NAME_REQUIRED') } : {}),
      ...(patch.content !== undefined ? { content: clone(patch.content) } : {}),
      ...(patch.source !== undefined ? { source: patch.source?.trim() } : {}),
      ...(patch.tags !== undefined ? { tags: cleanList(patch.tags, 'ASSET_TAG_INVALID') } : {}),
      ...(patch.approvalStatus !== undefined ? { approvalStatus: patch.approvalStatus } : {}),
      ...(patch.rightsStatus !== undefined ? { rightsStatus: patch.rightsStatus } : {}),
      revision: current.revision + 1, updatedAt: this.now(),
    }
    this.assets.set(id, next)
    return clone(next)
  }

  deleteAsset(workspaceId: string, id: string): void {
    const asset = this.assets.get(id)
    if (!asset || asset.workspaceId !== workspaceId) throw new KnowledgeError('ASSET_NOT_FOUND')
    this.assets.delete(id)
  }

  queryAssets(query: AssetQuery): AssetEntry[] {
    const workspaceId = requiredText(query.workspaceId, 'WORKSPACE_REQUIRED')
    const text = query.text?.trim().toLocaleLowerCase()
    return [...this.assets.values()].filter(asset => asset.workspaceId === workspaceId)
      .filter(asset => !query.kind || asset.kind === query.kind)
      .filter(asset => !text || asset.name.toLocaleLowerCase().includes(text) || JSON.stringify(asset.content).toLocaleLowerCase().includes(text))
      .filter(asset => !query.tags?.length || query.tags.every(tag => asset.tags.includes(tag)))
      .map(clone)
  }

  listAssets(query: AssetQuery): AssetEntry[] { return this.queryAssets(query) }

  recordFeedback(input: FeedbackCreateInput): FeedbackRecord {
    const record: FeedbackRecord = {
      id: this.nextId('feedback'), workspaceId: requiredText(input.workspaceId, 'WORKSPACE_REQUIRED'), kind: input.kind,
      ...(input.platform ? { platform: input.platform.trim() } : {}), ...(input.contentId ? { contentId: input.contentId.trim() } : {}),
      reason: requiredText(input.reason, 'FEEDBACK_REASON_REQUIRED'), ...(input.details ? { details: input.details.trim() } : {}),
      metadata: { ...(input.metadata ?? {}) }, createdAt: this.now(),
    }
    this.feedback.set(record.id, record)
    this.createSuggestion(record)
    return clone(record)
  }

  recordObservedFeedback(input: FeedbackCreateInput & { sourceKey: string; createdAt?: string }): FeedbackRecord {
    const sourceKey = requiredText(input.sourceKey, 'FEEDBACK_SOURCE_KEY_REQUIRED')
    const existing = [...this.feedback.values()].find(item => item.workspaceId === input.workspaceId && item.metadata.source_key === sourceKey)
    if (existing) return clone(existing)
    const record: FeedbackRecord = {
      id: `feedback_observed_${sourceKey}`, workspaceId: requiredText(input.workspaceId, 'WORKSPACE_REQUIRED'), kind: input.kind,
      ...(input.platform ? { platform: input.platform.trim() } : {}), ...(input.contentId ? { contentId: input.contentId.trim() } : {}),
      reason: requiredText(input.reason, 'FEEDBACK_REASON_REQUIRED'), ...(input.details ? { details: input.details.trim() } : {}),
      metadata: { ...(input.metadata ?? {}), source_key: sourceKey }, createdAt: input.createdAt ?? this.now(),
    }
    this.feedback.set(record.id, record)
    this.createSuggestion(record, `learning_observed_${sourceKey}`)
    return clone(record)
  }

  listFeedback(workspaceId: string, kind?: FeedbackKind): FeedbackRecord[] {
    return [...this.feedback.values()].filter(item => item.workspaceId === workspaceId && (!kind || item.kind === kind)).map(clone)
  }

  getFeedback(workspaceId: string, feedbackId: string): FeedbackRecord | undefined {
    const record = this.feedback.get(feedbackId)
    return record?.workspaceId === workspaceId ? clone(record) : undefined
  }

  removeUnpersistedFeedback(workspaceId: string, feedbackId: string): void {
    const record = this.feedback.get(feedbackId)
    if (!record || record.workspaceId !== workspaceId) return
    this.feedback.delete(feedbackId)
    for (const [id, suggestion] of this.suggestions) if (suggestion.workspaceId === workspaceId && suggestion.feedbackId === feedbackId) this.suggestions.delete(id)
  }

  private createSuggestion(record: FeedbackRecord, suggestionId?: string): LearningSuggestion {
    const scope: RuleScope = record.platform ? 'platform' : 'global'
    const suggestion: LearningSuggestion = {
      id: suggestionId ?? this.nextId('learning'), workspaceId: record.workspaceId, feedbackId: record.id, status: 'pending',
      summary: `根据${record.kind === 'platform_rejection' ? '平台驳回' : '反馈'}“${record.reason}”生成待确认建议`,
      proposedRule: {
        content: record.details ? `${record.reason}：${record.details}` : record.reason,
        scope, ...(record.platform ? { scopeValue: record.platform } : {}),
        source: { kind: 'observed', reference: `feedback:${record.id}`, checkedAt: record.createdAt }, version: 'suggested-1', status: 'draft',
      },
      createdAt: record.createdAt, updatedAt: record.createdAt,
    }
    this.suggestions.set(suggestion.id, suggestion)
    return suggestion
  }

  listLearningSuggestions(workspaceId: string, status?: LearningSuggestionStatus): LearningSuggestion[] {
    return [...this.suggestions.values()].filter(item => item.workspaceId === workspaceId && (!status || item.status === status)).map(clone)
  }

  getLearningSuggestion(workspaceId: string, suggestionId: string): LearningSuggestion | undefined {
    const suggestion = this.suggestions.get(suggestionId)
    return suggestion?.workspaceId === workspaceId ? clone(suggestion) : undefined
  }

  confirmLearningSuggestion(input: ConfirmLearningSuggestionInput): LearningSuggestion {
    const suggestion = this.suggestions.get(input.suggestionId)
    if (!suggestion || suggestion.workspaceId !== input.workspaceId) throw new KnowledgeError('LEARNING_SUGGESTION_NOT_FOUND')
    if (suggestion.status !== 'pending') throw new KnowledgeError('LEARNING_SUGGESTION_ALREADY_REVIEWED')
    const confirmedBy = requiredText(input.confirmedBy, 'CONFIRMED_BY_REQUIRED')
    const next: LearningSuggestion = {
      ...suggestion, status: 'confirmed', confirmedBy, updatedAt: this.now(), confirmedAt: this.now(),
      ...(input.note ? { confirmationNote: input.note.trim() } : {}),
    }
    this.suggestions.set(next.id, next)
    return clone(next)
  }

  confirmSuggestion(input: ConfirmLearningSuggestionInput): LearningSuggestion { return this.confirmLearningSuggestion(input) }

  dismissLearningSuggestion(workspaceId: string, suggestionId: string, note?: string): LearningSuggestion {
    const suggestion = this.suggestions.get(suggestionId)
    if (!suggestion || suggestion.workspaceId !== workspaceId) throw new KnowledgeError('LEARNING_SUGGESTION_NOT_FOUND')
    if (suggestion.status !== 'pending') throw new KnowledgeError('LEARNING_SUGGESTION_ALREADY_REVIEWED')
    const next = { ...suggestion, status: 'dismissed' as const, updatedAt: this.now(), ...(note ? { confirmationNote: note.trim() } : {}) }
    this.suggestions.set(next.id, next)
    return clone(next)
  }

  createCompetitorAnalysis(input: CompetitorCreateInput): CompetitorAnalysis {
    assertCompetitorInput(input)
    const now = this.now()
    const competitorName = requiredText(input.competitorName, 'COMPETITOR_NAME_REQUIRED')
    const analysis: CompetitorAnalysis = {
      id: this.nextId('competitor'), workspaceId: requiredText(input.workspaceId, 'WORKSPACE_REQUIRED'), competitorName,
      source: { url: requiredText(input.source?.url, 'COMPETITOR_SOURCE_REQUIRED'), title: requiredText(input.source?.title, 'COMPETITOR_SOURCE_REQUIRED'), accessedAt: requiredText(input.source?.accessedAt, 'COMPETITOR_SOURCE_REQUIRED') },
      summary: requiredText(input.summary, 'COMPETITOR_SUMMARY_REQUIRED'), structure: normalizeStructure(input.structure),
      sellingPoints: cleanList(input.sellingPoints, 'COMPETITOR_SELLING_POINT_INVALID'), expression: normalizeExpression(input.expression),
      createdAt: now, updatedAt: now,
    }
    validDate(analysis.source.accessedAt, 'COMPETITOR_SOURCE_INVALID')
    this.competitors.set(analysis.id, analysis)
    return clone(analysis)
  }

  getCompetitorAnalysis(workspaceId: string, id: string): CompetitorAnalysis | undefined {
    const analysis = this.competitors.get(id)
    return analysis?.workspaceId === workspaceId ? clone(analysis) : undefined
  }

  updateCompetitorAnalysis(workspaceId: string, id: string, patch: CompetitorUpdateInput): CompetitorAnalysis {
    assertCompetitorInput(patch)
    const current = this.competitors.get(id)
    if (!current || current.workspaceId !== workspaceId) throw new KnowledgeError('COMPETITOR_NOT_FOUND')
    const next: CompetitorAnalysis = {
      ...current,
      ...(patch.competitorName !== undefined ? { competitorName: requiredText(patch.competitorName, 'COMPETITOR_NAME_REQUIRED') } : {}),
      ...(patch.source ? { source: { url: requiredText(patch.source.url, 'COMPETITOR_SOURCE_REQUIRED'), title: requiredText(patch.source.title, 'COMPETITOR_SOURCE_REQUIRED'), accessedAt: requiredText(patch.source.accessedAt, 'COMPETITOR_SOURCE_REQUIRED') } } : {}),
      ...(patch.summary !== undefined ? { summary: requiredText(patch.summary, 'COMPETITOR_SUMMARY_REQUIRED') } : {}),
      ...(patch.structure ? { structure: normalizeStructure(patch.structure) } : {}),
      ...(patch.sellingPoints ? { sellingPoints: cleanList(patch.sellingPoints, 'COMPETITOR_SELLING_POINT_INVALID') } : {}),
      ...(patch.expression ? { expression: normalizeExpression(patch.expression) } : {}),
      updatedAt: this.now(),
    }
    this.competitors.set(id, next)
    return clone(next)
  }

  deleteCompetitorAnalysis(workspaceId: string, id: string): void {
    const analysis = this.competitors.get(id)
    if (!analysis || analysis.workspaceId !== workspaceId) throw new KnowledgeError('COMPETITOR_NOT_FOUND')
    this.competitors.delete(id)
  }

  queryCompetitorAnalyses(query: CompetitorQuery): CompetitorAnalysis[] {
    const workspaceId = requiredText(query.workspaceId, 'WORKSPACE_REQUIRED')
    const text = query.text?.trim().toLocaleLowerCase()
    return [...this.competitors.values()].filter(item => item.workspaceId === workspaceId)
      .filter(item => !query.competitorName || item.competitorName === query.competitorName)
      .filter(item => !text || [item.competitorName, item.summary, ...item.sellingPoints].some(value => value.toLocaleLowerCase().includes(text)))
      .map(clone)
  }

  listCompetitorAnalyses(query: CompetitorQuery): CompetitorAnalysis[] { return this.queryCompetitorAnalyses(query) }

  buildDifferentiationReference(input: DifferentiationReferenceInput): DifferentiationReference {
    const analysis = this.competitors.get(input.competitorId)
    if (!analysis || analysis.workspaceId !== input.workspaceId) throw new KnowledgeError('COMPETITOR_NOT_FOUND')
    const ownBrandName = requiredText(input.ownBrandName, 'OWN_BRAND_NAME_REQUIRED')
    if (ownBrandName.toLocaleLowerCase() === analysis.competitorName.toLocaleLowerCase()) throw new KnowledgeError('COMPETITOR_BRAND_REUSE_FORBIDDEN')
    const ownSellingPoints = cleanList(input.ownSellingPoints, 'OWN_SELLING_POINT_INVALID')
    const competitorPoints = new Set(analysis.sellingPoints.map(point => point.toLocaleLowerCase()))
    const differentiationAngles = ownSellingPoints.filter(point => !competitorPoints.has(point.toLocaleLowerCase()))
    return {
      competitorAnalysisId: analysis.id, referenceMode: 'differentiation_only',
      structuralObservations: [...analysis.structure.sections, ...(analysis.structure.layout ?? [])].map(value => `可参考结构特征：${value}`),
      expressionObservations: [...analysis.expression.tone, ...analysis.expression.formats].map(value => `可观察表达特征：${value}`),
      differentiationAngles: differentiationAngles.length ? differentiationAngles.map(value => `优先使用自有事实突出：${value}`) : ['补充与竞品不同的自有事实、场景或服务价值'],
      safeExpressionGuidance: [
        `围绕${ownBrandName}的自有商品事实重新撰写`,
        '只参考结构和表达特征，不复制原文、句式组合或竞品品牌标识',
        '发布前仍需经过品牌与平台规则审核',
      ],
      compliance: { originalTextCopied: false, competitorBrandReused: false },
    }
  }
}

export { KnowledgeModule as KnowledgeBase, KnowledgeModule as InMemoryKnowledgeStore }
