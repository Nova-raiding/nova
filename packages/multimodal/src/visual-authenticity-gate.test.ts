import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  evaluateVisualAuthenticity,
  type ObservedVisualChange,
  type VisualAuthenticityGateInput,
  type VisualComparisonEvidence,
} from './visual-authenticity-gate.js'

const hash = (character: string) => character.repeat(64)
const unchanged = (confidence = 0.99): VisualComparisonEvidence => ({ outcome: 'unchanged', confidence })
const attestation = (candidateHash: string, reviewerId: string, reviewedAt: string) =>
  createHash('sha256').update(`${candidateHash.replace(/^sha256:/u, '')}\0${reviewerId}\0${reviewedAt}`).digest('hex')

const validInput = (overrides: Partial<VisualAuthenticityGateInput> = {}): VisualAuthenticityGateInput => ({
  originalImage: { width: 1200, height: 1200, hash: hash('a') },
  candidateImage: { width: 1200, height: 1200, hash: `sha256:${hash('b')}` },
  protectedRegions: [
    { id: 'logo', label: '品牌 Logo', kind: 'logo', rect: { x: 0, y: 0, width: 0.2, height: 0.2 } },
    { id: 'cert', label: 'Certification Mark', kind: 'certification_mark', rect: { x: 0.8, y: 0, width: 0.2, height: 0.2 } },
    { id: 'package', label: '包装文字 / Packaging Text', kind: 'packaging_text', rect: { x: 0.3, y: 0.3, width: 0.4, height: 0.4 } },
  ],
  editableRegions: [{ id: 'copy', label: '营销文案 / Marketing Copy', kind: 'marketing_copy', rect: { x: 0, y: 0.7, width: 1, height: 0.3 } }],
  observedChanges: [
    { id: 'background-change', kind: 'background', rect: { x: 0.2, y: 0, width: 0.6, height: 0.25 } },
    { id: 'lighting-change', kind: 'lighting', rect: { x: 0.7, y: 0.3, width: 0.3, height: 0.4 } },
    { id: 'copy-change', kind: 'marketing_copy', rect: { x: 0.1, y: 0.75, width: 0.8, height: 0.15 } },
  ],
  ocr: {
    original: [{ text: '品牌 BRAND', confidence: 0.98, regionId: 'logo', language: 'zh-en' }],
    candidate: [{ text: '品牌 BRAND', confidence: 0.97, regionId: 'logo', language: 'zh-en' }],
  },
  protectedComparisons: { logo: unchanged(), certificationMark: unchanged(), packagingText: unchanged() },
  productComparisons: { structure: unchanged(), color: unchanged(), material: unchanged() },
  provenance: { source: 'asset:original-1@r3', provider: 'visual-diff-provider', model: 'authenticity-model-2026-08' },
  humanReview: { status: 'not_required' },
  ...overrides,
})

describe('visual authenticity and finished-image usability gate', () => {
  it('passes compliant evidence and allows background, lighting and composition changes', () => {
    const result = evaluateVisualAuthenticity(validInput({
      observedChanges: [
        { id: 'background', kind: 'background', rect: { x: 0.2, y: 0, width: 0.5, height: 0.2 } },
        { id: 'lighting', kind: 'lighting', rect: { x: 0.7, y: 0.25, width: 0.3, height: 0.4 } },
        { id: 'composition', kind: 'composition', rect: { x: 0.7, y: 0.7, width: 0.3, height: 0.3 } },
      ],
    }))

    expect(result).toMatchObject({ status: 'pass', publishable: true, requiresHumanReview: false, nextActions: [] })
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'AUTHENTICITY_EVIDENCE_COMPLETE', status: 'pass' }))
  })

  it('preserves Chinese and English labels in protected-region blocker evidence', () => {
    const result = evaluateVisualAuthenticity(validInput({
      observedChanges: [{ id: 'bad-logo-edit', kind: 'logo', rect: { x: 0.05, y: 0.05, width: 0.1, height: 0.1 } }],
      protectedComparisons: { logo: { outcome: 'changed', confidence: 0.99, originalValue: '品牌', candidateValue: 'BRANO' }, certificationMark: unchanged(), packagingText: unchanged() },
    }))

    expect(result).toMatchObject({ status: 'block', publishable: false })
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PROTECTED_REGION_CHANGED', evidence: expect.objectContaining({ protectedLabel: '品牌 Logo' }) }),
      expect.objectContaining({ code: 'LOGO_DRIFT', status: 'block' }),
    ]))
  })

  it('accepts exact edge contact but blocks positive-area overlap at a boundary', () => {
    const edgeContact = evaluateVisualAuthenticity(validInput({
      protectedRegions: [{ id: 'left-logo', label: 'Logo', kind: 'logo', rect: { x: 0, y: 0, width: 0.2, height: 0.2 } }],
      editableRegions: [{ id: 'right-copy', label: '可编辑', kind: 'marketing_copy', rect: { x: 0.2, y: 0, width: 0.8, height: 0.2 } }],
      observedChanges: [{ id: 'edge-copy', kind: 'marketing_copy', rect: { x: 0.2, y: 0, width: 0.2, height: 0.2 } }],
    }))
    expect(edgeContact.status).toBe('pass')

    const overlap = evaluateVisualAuthenticity(validInput({
      protectedRegions: [{ id: 'left-logo', label: 'Logo', kind: 'logo', rect: { x: 0, y: 0, width: 0.2, height: 0.2 } }],
      editableRegions: [{ id: 'right-copy', label: '可编辑', kind: 'marketing_copy', rect: { x: 0.199, y: 0, width: 0.801, height: 0.2 } }],
      observedChanges: [],
    }))
    expect(overlap.findings).toContainEqual(expect.objectContaining({ code: 'REGION_POLICY_CONFLICT', status: 'block' }))
  })

  it('fails closed for missing candidate and invalid dimension/hash evidence', () => {
    const missing = evaluateVisualAuthenticity(validInput({ candidateImage: undefined }))
    expect(missing.findings).toContainEqual(expect.objectContaining({ code: 'CANDIDATE_IMAGE_MISSING' }))

    const invalid = evaluateVisualAuthenticity(validInput({ candidateImage: { width: 0, height: 1200.5, hash: 'not-a-hash' } }))
    expect(invalid).toMatchObject({ status: 'block', publishable: false })
    expect(invalid.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'IMAGE_DIMENSIONS_INVALID' }),
      expect.objectContaining({ code: 'IMAGE_HASH_INVALID' }),
    ]))
  })

  it('fails closed when required OCR, comparison or provenance evidence is missing', () => {
    const result = evaluateVisualAuthenticity(validInput({
      ocr: undefined as never,
      protectedComparisons: { logo: undefined as never, certificationMark: unchanged(), packagingText: unchanged() },
      provenance: { source: '', provider: '', model: '' },
    }))

    expect(result.status).toBe('block')
    expect(result.findings.filter(finding => finding.code === 'EVIDENCE_MISSING').length).toBeGreaterThanOrEqual(3)
  })

  it('warns and requires human review for low-confidence evidence instead of reporting success', () => {
    const result = evaluateVisualAuthenticity(validInput({
      ocr: { original: [{ text: '包装文字', confidence: 0.79 }], candidate: [{ text: '包装文字', confidence: 0.78 }] },
      productComparisons: { structure: unchanged(0.79), color: unchanged(), material: unchanged() },
      humanReview: { status: 'pending' },
    }))

    expect(result).toMatchObject({ status: 'warn', publishable: false, requiresHumanReview: true })
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'LOW_CONFIDENCE_REQUIRES_HUMAN_REVIEW', status: 'warn' }))
    expect(result.nextActions).toContainEqual(expect.objectContaining({ code: 'COMPLETE_HUMAN_VISUAL_REVIEW', priority: 'required' }))
  })

  it('allows low-confidence evidence only after valid human review attestation', () => {
    const reviewedAt = new Date(Date.now() - 60_000).toISOString()
    const result = evaluateVisualAuthenticity(validInput({
      protectedComparisons: { logo: unchanged(0.7), certificationMark: unchanged(), packagingText: unchanged() },
      humanReview: { status: 'approved', reviewerId: 'reviewer-17', reviewedAt, attestationHash: attestation(hash('b'), 'reviewer-17', reviewedAt) },
    }))

    expect(result).toMatchObject({ status: 'pass', publishable: true, requiresHumanReview: false })
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'LOW_CONFIDENCE_HUMAN_VERIFIED', status: 'pass' }))
  })

  it('blocks forged approval and every protected product-attribute drift', () => {
    const forged = evaluateVisualAuthenticity(validInput({
      humanReview: { status: 'approved', reviewerId: 'reviewer-17' },
    }))
    expect(forged.findings).toContainEqual(expect.objectContaining({ code: 'HUMAN_REVIEW_ATTESTATION_INVALID', status: 'block' }))

    const changed = evaluateVisualAuthenticity(validInput({
      productComparisons: {
        structure: { outcome: 'changed', confidence: 0.99 },
        color: { outcome: 'changed', confidence: 0.99 },
        material: { outcome: 'changed', confidence: 0.99 },
      },
      protectedComparisons: {
        logo: unchanged(),
        certificationMark: { outcome: 'changed', confidence: 0.99 },
        packagingText: { outcome: 'changed', confidence: 0.99 },
      },
    }))
    expect(changed.findings.map(finding => finding.code)).toEqual(expect.arrayContaining([
      'PRODUCT_STRUCTURE_CHANGED', 'PRODUCT_COLOR_CHANGED', 'PRODUCT_MATERIAL_CHANGED',
      'CERTIFICATION_MARK_DRIFT', 'PACKAGING_TEXT_DRIFT',
    ]))
    expect(changed.status).toBe('block')
  })

  it('rejects detached low-confidence attestations and inherited fake approvals', () => {
    const reviewedAt = new Date(Date.now() - 1_000).toISOString()
    const detached = evaluateVisualAuthenticity(validInput({
      protectedComparisons: { logo: unchanged(0.5), certificationMark: unchanged(), packagingText: unchanged() },
      humanReview: { status: 'approved', reviewerId: 'reviewer-17', reviewedAt, attestationHash: hash('d') },
    }))
    expect(detached.findings).toContainEqual(expect.objectContaining({ code: 'HUMAN_REVIEW_ATTESTATION_INVALID', status: 'block' }))

    const inherited = Object.create({ status: 'approved', reviewerId: 'reviewer-17', reviewedAt, attestationHash: attestation(hash('b'), 'reviewer-17', reviewedAt) })
    const polluted = evaluateVisualAuthenticity(validInput({
      protectedComparisons: { logo: unchanged(0.5), certificationMark: unchanged(), packagingText: unchanged() },
      humanReview: inherited,
    }))
    expect(polluted.publishable).toBe(false)
    expect(polluted.findings).toContainEqual(expect.objectContaining({ code: 'EVIDENCE_MISSING', path: 'humanReview' }))
  })

  it('fails closed on non-finite dimensions, oversized text and collection bombs', () => {
    const oversizedChanges = Array.from({ length: 1_001 }, (_, index) => ({ id: `change-${index}`, kind: 'background' as const, rect: { x: 0, y: 0, width: 0.1, height: 0.1 } }))
    const result = evaluateVisualAuthenticity(validInput({
      originalImage: { width: Number.POSITIVE_INFINITY, height: -1, hash: hash('a') },
      observedChanges: oversizedChanges,
      provenance: { source: 'x'.repeat(8_193), provider: 'provider', model: 'model' },
    }))
    expect(result.publishable).toBe(false)
    expect(result.findings.map(item => item.code)).toEqual(expect.arrayContaining(['IMAGE_DIMENSIONS_INVALID', 'REGION_INVALID', 'EVIDENCE_MISSING']))
  })

  it('rejects inherited comparison outcomes and invalid region kinds', () => {
    const result = evaluateVisualAuthenticity(validInput({
      protectedRegions: [{ id: 'bad', label: 'bad', kind: 'logo' as const, rect: { x: 0, y: 0, width: 0.1, height: 0.1 }, __proto__: { kind: 'background' } } as never],
      protectedComparisons: { logo: Object.create({ outcome: 'unchanged', confidence: 1 }), certificationMark: unchanged(), packagingText: unchanged() },
    }))
    expect(result.publishable).toBe(false)
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'EVIDENCE_MISSING', path: 'protectedComparisons.logo' }))
  })

  it('returns recursively frozen evidence without retaining input arrays', () => {
    const input = validInput()
    const result = evaluateVisualAuthenticity(input)
    ;(input.observedChanges as ObservedVisualChange[]).push({ id: 'late', kind: 'background', rect: { x: 0, y: 0, width: 0.1, height: 0.1 } })
    expect(result.status).toBe('pass')
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.findings)).toBe(true)
  })
})
