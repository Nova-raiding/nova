export type RulePackScope = 'global' | 'platform' | 'category' | 'brand' | 'store' | 'campaign';
export type RulePackStatus = 'draft' | 'active' | 'inactive' | 'expired';
export type RuleAuditAction = 'created' | 'activated' | 'deactivated' | 'expired';
export type RuleSeverity = 'error' | 'warning';
export type RuleAction = 'block' | 'warn' | 'review' | 'allow';
export interface RuleEvaluationContext {
    platform?: string;
    category?: string;
    brand?: string;
    store?: string;
    campaign?: string;
}
export interface RuleSource {
    kind: 'official' | 'internal' | 'legal_review';
    reference: string;
    checkedAt: string;
}
export interface RuleChecks {
    forbiddenTerms?: string[];
    requiredFields?: string[];
}
/** Immutable, auditable version of a rule pack. The version is never edited in place. */
export interface RulePackVersion {
    id: string;
    packId: string;
    name: string;
    version: string;
    scope: RulePackScope;
    status: RulePackStatus;
    source: RuleSource;
    checksum: string;
    checks: RuleChecks;
    createdAt: string;
    updatedAt: string;
    createdBy: string;
    revision: number;
    effectiveFrom?: string;
    effectiveTo?: string;
    severity?: RuleSeverity;
    action?: RuleAction;
    targetId?: string;
    /** Compatibility alias used by some rule imports. */
    scopeValue?: string;
    activatedAt?: string;
    deactivatedAt?: string;
}
/** Public list projection; it deliberately excludes executable rule details. */
export interface RulePack {
    id: string;
    name: string;
    version: string;
    scope: RulePackScope;
    status: RulePackStatus;
    updatedAt: string;
    source: RuleSource;
    checksum: string;
    revision: number;
    effectiveFrom?: string;
    effectiveTo?: string;
    severity?: RuleSeverity;
    action?: RuleAction;
    targetId?: string;
    scopeValue?: string;
    activatedAt?: string;
    deactivatedAt?: string;
}
export interface RuleAuditEvent {
    id: string;
    rulePackId: string;
    ruleVersionId: string;
    version: string;
    action: RuleAuditAction;
    actorId: string;
    reason?: string;
    at: string;
}
export interface RuleCenterSeed {
    packId: string;
    name: string;
    version: string;
    scope: RulePackScope;
    status?: RulePackStatus;
    source: RuleSource;
    checks?: RuleChecks;
    createdAt?: string;
    createdBy?: string;
    effectiveFrom?: string;
    effectiveTo?: string;
    severity?: RuleSeverity;
    action?: RuleAction;
    targetId?: string;
    scopeValue?: string;
}
export interface RuleEvaluationFinding {
    code: 'RULE_EXPIRED' | 'RULE_NOT_YET_EFFECTIVE' | 'RULE_PRIORITY_CONFLICT';
    severity: RuleSeverity;
    action: RuleAction;
    field: 'rules';
    ruleVersionId: string;
    message: string;
}
export interface RuleHit {
    ruleVersionId: string;
    version: string;
    scope: RulePackScope;
    action: RuleAction;
    severity: RuleSeverity;
    matchedChecks: string[];
}
export interface RuleEvaluation {
    /** Applicable rules are ordered from broadest to most specific scope. */
    applicable: RulePackVersion[];
    checks: RuleChecks;
    findings: RuleEvaluationFinding[];
    hits: RuleHit[];
}
/**
 * Small rule registry used by the application layer.
 *
 * The external API is intentionally read-only for now. Administrative callers
 * can use the explicit publish/status methods, which enforce immutable versions
 * and leave an audit event for every state change.
 */
export declare class RuleCenter {
    private readonly clock;
    private readonly versions;
    private readonly audits;
    private sequence;
    constructor(clock?: () => string, seeds?: readonly RuleCenterSeed[]);
    private nextAuditId;
    private versionId;
    private checksum;
    private validate;
    private seed;
    private latest;
    private projection;
    list(options?: {
        includeInactive?: boolean;
    }): RulePack[];
    history(packId: string): RulePack[];
    get(packId: string, version?: string): RulePack;
    activeVersionIds(): string[];
    activeChecks(): RuleChecks;
    /**
     * Resolves active rules from broad to specific scope and evaluates their
     * validity window. Existing callers can continue using activeChecks(); this
     * method is the opt-in context-aware path for reviews.
     */
    evaluate(context?: RuleEvaluationContext, at?: string): RuleEvaluation;
    publish(input: Omit<RuleCenterSeed, 'status'> & {
        actorId: string;
        reason?: string;
    }): RulePack;
    setStatus(input: {
        packId: string;
        version?: string;
        status: 'active' | 'inactive' | 'expired';
        actorId: string;
        reason: string;
    }): RulePack;
    audit(packId?: string): RuleAuditEvent[];
}
export declare const defaultRuleCenterSeeds: readonly RuleCenterSeed[];
//# sourceMappingURL=rule-center.d.ts.map