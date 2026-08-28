import type { RuleCenter, RuleEvaluationContext, RuleHit } from './rule-center.js';
export type ReviewSeverity = 'error' | 'warning';
export type ReviewPriority = 'P0' | 'P1' | 'P2';
export type ReviewFindingStatus = 'open' | 'acknowledged' | 'resolved' | 'waived';
export type ReviewCategoryId = 'product_truth' | 'brand_consistency' | 'copy_price_compliance' | 'visual_brief_quality' | 'technical_specification' | 'platform_preflight';
/**
 * Evidence is deliberately scoped to checks performed by this application.
 * `externalVerification` is a boundary marker, not a claim about any platform.
 */
export interface ReviewEvidence {
    kind: 'fact' | 'rule' | 'brand' | 'content' | 'image';
    sourceIds: string[];
    verified: boolean;
    scope: 'local_deterministic';
    externalVerification: 'not_performed';
    boundary: '外部平台审核、OCR 和线上渲染效果未在本地审核中验证';
}
export interface ReviewFinding {
    code: 'MISSING_SOURCE' | 'MISSING_RULE_VERSION' | 'PRICE_NOT_ALLOWED' | 'SKU_MISMATCH' | 'SKU_IMAGE_MAPPING_INVALID' | 'FORBIDDEN_TERM' | 'BRAND_FORBIDDEN_TERM' | 'BRAND_VISUAL_ASSET_NOT_READY' | 'BRAND_FONT_LICENSE_NOT_APPROVED' | 'RULE_EXPIRED' | 'RULE_NOT_YET_EFFECTIVE' | 'RULE_PRIORITY_CONFLICT' | 'PROMOTION_EXPIRED' | 'PROMOTION_SCOPE_INVALID' | 'PROMOTION_SKU_UNREFERENCED' | 'MAIN_IMAGE_REQUIRED' | 'IMAGE_URL_INVALID' | 'DUPLICATE_IMAGE' | 'IMAGE_FORMAT_UNSUPPORTED' | 'IMAGE_TOO_SMALL' | 'PRODUCT_FACTS_UNCONFIRMED' | 'SELLING_POINT_PROOF_MISSING' | 'VISUAL_BRIEF_MISSING' | 'VISUAL_BRIEF_INCOMPLETE' | 'TECHNICAL_SCHEMA_INVALID' | 'TECHNICAL_EXPORT_MANIFEST_MISSING' | 'PLATFORM_PREFLIGHT_PENDING';
    severity: ReviewSeverity;
    priority: ReviewPriority;
    status: ReviewFindingStatus;
    field: string;
    message: string;
    repairSuggestion: string;
    evidence: ReviewEvidence;
    decision?: {
        reason: string;
        actorId: string;
        updatedAt: string;
    };
}
export interface ReviewCategoryResult {
    id: ReviewCategoryId;
    name: string;
    status: 'passed' | 'warning' | 'blocking' | 'not_evaluated' | 'external_pending';
    findingCount: number;
    summary: string;
}
export interface ReviewReport {
    findings: ReviewFinding[];
    categories: ReviewCategoryResult[];
    blocking: boolean;
    evidenceBoundary: ReviewEvidence['boundary'];
    ruleHits?: RuleHit[];
}
export declare const REVIEW_EVIDENCE_BOUNDARY: ReviewEvidence['boundary'];
export declare function reviewProductImages(images: readonly string[] | undefined): ReviewFinding[];
export interface DeterministicReviewInput {
    body: {
        title: string;
        detail: string;
        sellingPoints: string[];
    };
    modules?: Array<{
        key: string;
        factSourceIds: string[];
    }>;
    facts: {
        skuIds: string[];
        price?: number;
        minPrice?: number;
        maxPrice?: number;
        sourceIds: string[];
    };
    referencedSkuIds: string[];
    skuImageMappings?: Array<{
        skuId: string;
        imageCount: number;
        sourceIds: string[];
    }>;
    ruleVersionIds: string[];
    forbiddenTerms?: string[];
    brand?: {
        forbiddenTerms: string[];
        sourceIds: string[];
    };
    availableRuleVersionIds?: string[];
    /** Optional context-aware rule evaluation; omitted for legacy callers. */
    ruleCenter?: RuleCenter;
    ruleContext?: RuleEvaluationContext;
    reviewAt?: string;
    productFactsConfirmed?: boolean;
    sellingPointProofs?: Array<{
        id: string;
        text: string;
        proofStatus: 'pending' | 'confirmed' | 'rejected';
        sourceIds: string[];
    }>;
    checkVisualBrief?: boolean;
    brief?: {
        platform: string;
        placement: string;
        targetDimensions: string;
        visualHierarchy: string[];
        productImageGuidance: string;
        logoSafety: string;
        headline: string;
        subheadline: string;
        coreSellingPoint: string;
        cta: string;
        textDensity: string;
        safeArea: string;
        protectedAreas: string[];
    };
    technical?: {
        schemaValid: boolean;
        exportManifestPresent?: boolean;
    };
    platformPreflight?: {
        status: 'verified' | 'pending' | 'blocked';
        reasons?: string[];
        sourceIds?: string[];
    };
    promotions?: Array<{
        platform: string;
        productId: string;
        accountId?: string;
        skuIds: string[];
        validFrom?: string;
        validTo?: string;
        sourceId?: string;
    }>;
    promotionContext?: {
        platform: string;
        productId: string;
        accountId?: string;
        skuIds: string[];
    };
}
/**
 * Deterministic P0 checks. This function never claims legal or platform
 * approval; it only blocks facts that are mechanically unverifiable.
 */
export declare function reviewDeterministic(input: DeterministicReviewInput): ReviewFinding[];
export declare function isReviewBlocking(findings: readonly ReviewFinding[]): boolean;
/**
 * Always returns all six PRD review categories. Categories without sufficient
 * local evidence are explicitly marked instead of being presented as passed.
 */
export declare function buildReviewReport(findings: ReviewFinding[], coverage: {
    brandProfileBound: boolean;
    visualBriefChecked: boolean;
    technicalSchemaChecked: boolean;
    platformMappingChecked: boolean;
    ruleHits?: RuleHit[];
}): ReviewReport;
//# sourceMappingURL=review.d.ts.map