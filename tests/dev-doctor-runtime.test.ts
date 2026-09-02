import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { codexAppHostEvidenceAudit, commercialRuntimeAudit, commercialRuntimeReadiness, composeServiceHealth, modelRelayEvidenceAudit, parseComposeServiceStates, releaseReadiness } from '../scripts/dev-doctor-runtime.js'

describe('developer doctor runtime checks', () => {
  it('parses Docker Compose newline-delimited JSON', () => {
    const rows = parseComposeServiceStates([
      JSON.stringify({ Service: 'api', State: 'running', Health: 'healthy', Status: 'Up (healthy)' }),
      JSON.stringify({ Service: 'worker-generation', State: 'running', Health: 'unhealthy', Status: 'Up (unhealthy)' }),
    ].join('\n'))
    expect(composeServiceHealth(rows, 'api')).toEqual({ present: true, healthy: true, detail: 'Up (healthy)' })
    expect(composeServiceHealth(rows, 'worker-generation')).toEqual({ present: true, healthy: false, detail: 'Up (unhealthy)' })
  })

  it('accepts Compose JSON arrays and reports absent services', () => {
    const rows = parseComposeServiceStates(JSON.stringify([{ Service: 'api-replica', State: 'running', Health: 'healthy' }]))
    expect(composeServiceHealth(rows, 'api-replica')).toMatchObject({ present: true, healthy: true })
    expect(composeServiceHealth(rows, 'worker-sync')).toEqual({ present: false, healthy: false, detail: 'not running' })
  })

  it('fails closed on malformed Compose output', () => {
    expect(parseComposeServiceStates('{broken')).toEqual([])
  })

  it('reads release readiness from the API envelope', () => {
    expect(releaseReadiness({ data: { ready: false } })).toBe(false)
    expect(releaseReadiness({ ready: true })).toBe(true)
    expect(releaseReadiness({ data: {} })).toBeUndefined()
  })

  it('reports commercial dependencies as blocked for fixture/local readiness without exposing configuration values', () => {
    expect(commercialRuntimeReadiness({ data: {
      writesEnabled: false,
      persistence: { ready: true },
      setup: {
        mode: 'fixture', productionGate: false,
        ai: { costGate: 'ready' },
        modelReadiness: Object.fromEntries(['text', 'image', 'image_edit', 'ocr', 'video'].map(name => [name, { ready: true }])),
        payment: { mode: 'fixture', configured: false, providerApiKey: 'must-not-be-returned' },
        objectStorage: { configured: true, mode: 'local', bucket: 'must-not-be-returned' },
        alertNotifications: { ready: false },
      },
    } })).toEqual({
      mode: 'fixture', writesEnabled: false, persistenceReady: true,
      paymentReady: false, paymentMode: 'fixture', modelRelayReady: false,
      objectStorageReady: false, objectStorageMode: 'local', scannerReady: false, alertReady: false, productionGate: false,
    })
  })

  it('recognizes a complete production commercial runtime contract', () => {
    expect(commercialRuntimeReadiness({ data: {
      writesEnabled: true,
      persistence: { ready: true },
      setup: {
        mode: 'production', productionGate: true,
        ai: { costGate: 'ready' },
        modelReadiness: Object.fromEntries(['text', 'image', 'image_edit', 'ocr', 'video'].map(name => [name, { ready: true }])),
        payment: { mode: 'provider', configured: true },
        objectStorage: { configured: true, mode: 's3' },
        assetScanner: { ready: true, mode: 'clamav_worker' },
        alertNotifications: { ready: true },
      },
    } })).toMatchObject({ paymentReady: true, modelRelayReady: true, objectStorageReady: true, scannerReady: true, productionGate: true })
    expect(commercialRuntimeReadiness({ data: {} })).toBeUndefined()
  })

  it('audits payment fixture and missing OAuth platforms as fail-closed blockers', () => {
    expect(commercialRuntimeAudit({ data: {
      writesEnabled: false,
      setup: {
        mode: 'fixture',
        productionGate: false,
        ai: { costGate: 'blocked' },
        modelReadiness: {
          text: { ready: false, providerConfigured: false, reasons: ['model_missing'] },
          image: { ready: true, providerConfigured: true, reasons: [] },
          image_edit: { ready: true, providerConfigured: true, reasons: [] },
          ocr: { ready: true, providerConfigured: true, reasons: [] },
          video: { ready: true, providerConfigured: true, reasons: [] },
        },
        payment: { mode: 'fixture', configured: false, reasons: ['payment_mode_must_be_provider'] },
        platforms: {
          jd: { oauthConfigured: true, ready: true },
          taobao: { oauthConfigured: false, ready: false },
          tmall: { oauthConfigured: true, ready: true },
          pinduoduo: { oauthConfigured: false, ready: false },
          xiaohongshu: { oauthConfigured: true, ready: true },
          douyin: { oauthConfigured: true, ready: true },
        },
      },
    } })).toEqual({
      mode: 'fixture',
      writesEnabled: false,
      payment: { ready: false, mode: 'fixture', reasons: ['payment_mode_must_be_provider'] },
      platforms: {
        ready: false,
        missingOAuthPlatforms: ['taobao', 'pinduoduo'],
        blockedPlatforms: ['taobao', 'pinduoduo'],
      },
      relay: {
        ready: false,
        costGateReady: false,
        blockedModalities: ['text'],
        missingProviderConfigured: ['text'],
        reasons: ['text:model_missing', 'cost_gate_blocked'],
      },
      productionGate: false,
    })
  })

  it('detects relay 503 and missing usage/cost/provider evidence as blocked release evidence', () => {
    expect(modelRelayEvidenceAudit({
      results: [
        { modality: 'text', state: 'ready', endpoint: '/probe', model: 'text-v1', providerRequestId: 'req-text', usageObserved: true, costObserved: true, costCny: 0.01 },
        { modality: 'image', state: 'blocked', endpoint: '/probe', model: 'image-v1', providerRequestId: 'req-image', usageObserved: false, costObserved: false, detail: 'relay returned HTTP 503', httpStatus: 503 },
        { modality: 'image_edit', state: 'ready', endpoint: '/probe', model: 'edit-v1', providerRequestId: '', usageObserved: true, costObserved: true, costCny: 0.02, detail: 'provider_request_id_missing' },
        { modality: 'ocr', state: 'ready', endpoint: '/probe', model: 'ocr-v1', providerRequestId: 'req-ocr', usageObserved: false, costObserved: true, costCny: 0.03, detail: 'usage_evidence_missing' },
        { modality: 'video', state: 'ready', endpoint: '/probe', model: 'video-v1', providerRequestId: 'req-video', usageObserved: true, costObserved: false, detail: 'cost_evidence_missing' },
      ],
    })).toEqual({
      ready: false,
      blockedModalities: ['image'],
      http503Modalities: ['image'],
      missingProviderRequestId: ['image_edit'],
      missingUsageEvidence: ['image', 'ocr'],
      missingCostEvidence: ['image', 'video'],
      reasons: [
        'image:state_blocked',
        'image:relay_http_503',
        'image_edit:provider_request_id_missing',
        'image:usage_evidence_missing',
        'ocr:usage_evidence_missing',
        'image:cost_evidence_missing',
        'video:cost_evidence_missing',
      ],
    })
  })

  it('requires Codex App host evidence to prove 503 error recovery', () => {
    expect(codexAppHostEvidenceAudit({
      scenarios: [
        { id: 'plugin_discovery' },
        { id: 'error_recovery', error_recovery: { trigger_http_status: 500, trigger_error_code: 'OTHER', reconciliation_required: false, outcome_evidence_ref: '' } },
      ],
    })).toEqual({
      ready: false,
      reasons: [
        'error_recovery_http_503_missing',
        'error_recovery_code_invalid',
        'error_recovery_reconciliation_required_missing',
        'error_recovery_outcome_evidence_missing',
      ],
    })
  })

  it('pins creative point database security to the release table set', () => {
    const source = readFileSync('scripts/dev-doctor.ts', 'utf8')

    for (const table of [
      'creative_point_access_state',
      'creative_point_adjustments_v2',
      'creative_point_allocations',
      'creative_point_grants',
      'creative_point_ledger_events',
      'creative_point_operations',
      'creative_point_provider_receipts_v2',
      'creative_point_reservations',
      'creative_point_reversals_v2',
    ]) expect(source).toContain(`'${table}'`)

    expect(source).toContain("relkind='r'")
    expect(source).toContain('missingCreativePointForceRls')
    expect(source).not.toContain('facts.forced_rls === 6')
  })
})
