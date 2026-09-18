import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { alertNotificationReady, apiProbeReady, codexAppHostEvidenceAudit, commercialRuntimeAudit, commercialRuntimeReadiness, composeServiceHealth, modelRelayEvidenceAudit, parseComposeServiceStates, releaseReadiness } from '../scripts/dev-doctor-runtime.js'

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

  it('does not treat a local or fixture /readyz HTTP 200 as production-ready', () => {
    const fixture = { data: { setup: { mode: 'fixture', productionGate: false } } }
    const production = { data: { setup: { mode: 'production', productionGate: true } } }
    expect(apiProbeReady(fixture, true, false)).toBe(true)
    expect(apiProbeReady(fixture, true, true)).toBe(false)
    expect(apiProbeReady(production, true, true)).toBe(true)
    expect(apiProbeReady(production, false, true)).toBe(false)
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
        alertNotifications: { enabled: false, ready: true },
      },
    } })).toMatchObject({ paymentReady: true, modelRelayReady: true, objectStorageReady: true, scannerReady: true, alertEnabled: false, alertReady: true, productionGate: true })
    expect(commercialRuntimeReadiness({ data: {} })).toBeUndefined()
  })

  it('treats explicitly disabled optional alerts as in scope while failing closed otherwise', () => {
    expect(alertNotificationReady(false, false)).toBe(true)
    expect(alertNotificationReady(false, undefined)).toBe(true)
    expect(alertNotificationReady(true, true)).toBe(true)
    expect(alertNotificationReady(true, false)).toBe(false)
    expect(alertNotificationReady(undefined, true)).toBe(false)
    expect(alertNotificationReady(undefined, undefined)).toBe(false)
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

  it('fails closed when relay evidence repeats a modality instead of allowing Map overwrite', () => {
    const results = ['text', 'image', 'image_edit', 'ocr', 'video'].map(modality => ({
      modality, state: 'ready', providerRequestId: `req-${modality}`, usageObserved: true, costObserved: true, costCny: 0.01,
    }))
    results.push({ modality: 'text', state: 'ready', providerRequestId: 'req-text-duplicate', usageObserved: true, costObserved: true, costCny: 0.01 })
    const audit = modelRelayEvidenceAudit({ results })
    expect(audit?.ready).toBe(false)
    expect(audit?.blockedModalities).toContain('text')
    expect(audit?.reasons).toContain('text:duplicate_result')
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

  it('keeps local compose diagnostics bound to the repository env file', () => {
    const source = readFileSync('scripts/dev-doctor.ts', 'utf8')
    expect(source).toContain("existsSync(resolve(root, '.env'))")
    expect(source).toContain("['--env-file', resolve(root, '.env')]")
    expect(source).toContain('...composeArgs,')
    expect(source).toContain("run('docker', [...composeArgs, 'exec'")
    expect(source).not.toContain('composeArgs.slice(1)')
  })

  it('keeps an unreadable rendered production config as a structured doctor failure', () => {
    const source = readFileSync('scripts/dev-doctor.ts', 'utf8')
    expect(source).toContain('const productionConfigReady = (() => {')
    expect(source).toContain('catch {')
    expect(source).toContain('return false')
  })

  it.each(['EISDIR', 'EACCES'])('reports an unreadable production locator without a raw %s error or path leak', code => {
    const source = readFileSync('scripts/dev-doctor.ts', 'utf8')
    const bootstrap = source.slice(source.indexOf('// This ignored file'), source.indexOf('const parseJsonFile'))
    const env: Record<string, string> = {}
    const add = vi.fn()
    const readLocator = vi.fn(() => { throw Object.assign(new Error(`${code}: private-config-secret/path`), { code }) })

    expect(() => runInNewContext(bootstrap, { root: '/isolated-doctor', process: { env }, resolve, existsSync: () => true, readFileSync: readLocator, add })).not.toThrow()
    expect(readLocator).toHaveBeenCalledOnce()
    expect(add).toHaveBeenCalledWith('production_config_locator', 'fail', expect.any(String), expect.any(String))
    expect(env.PRODUCTION_CONFIG_PATH).toBeUndefined()
    expect(JSON.stringify(add.mock.calls)).not.toContain('private-config-secret')
    expect(JSON.stringify(add.mock.calls)).not.toContain(code)
  })

  it('preserves an explicit production path without reading the fallback locator', () => {
    const source = readFileSync('scripts/dev-doctor.ts', 'utf8')
    const bootstrap = source.slice(source.indexOf('// This ignored file'), source.indexOf('const parseJsonFile'))
    const env = { PRODUCTION_CONFIG_PATH: '/explicit/production.yaml' }
    const readLocator = vi.fn()
    const add = vi.fn()
    runInNewContext(bootstrap, { root: '/isolated-doctor', process: { env }, resolve, existsSync: () => true, readFileSync: readLocator, add })
    expect(readLocator).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
    expect(env.PRODUCTION_CONFIG_PATH).toBe('/explicit/production.yaml')
  })

  it.each([true, false])('only reads macOS workstation MCP configuration in local diagnosis (production=%s)', production => {
    const source = readFileSync('scripts/dev-doctor.ts', 'utf8')
    const bootstrap = source.slice(source.indexOf('// The desktop plugin'), source.indexOf('// Compose resolves'))
    const env: Record<string, string> = { MERCHANT_MCP_BASE_URL: 'https://explicit.invalid' }
    const launchctl = vi.fn((_command: string, args: string[]) => args[1] === 'MERCHANT_MCP_TOKEN' ? 'private-workstation-token' : 'ws_local')
    runInNewContext(bootstrap, { production, process: { platform: 'darwin', env }, execFileSync: launchctl })
    expect(env.MERCHANT_MCP_BASE_URL).toBe('https://explicit.invalid')
    if (production) {
      expect(launchctl).not.toHaveBeenCalled()
      expect(env.MERCHANT_MCP_TOKEN).toBeUndefined()
      expect(env.MERCHANT_WORKSPACE_ID).toBeUndefined()
    } else {
      expect(launchctl).toHaveBeenCalledTimes(2)
      expect(env.MERCHANT_MCP_TOKEN).toBe('private-workstation-token')
      expect(env.MERCHANT_WORKSPACE_ID).toBe('ws_local')
    }
  })

  it('documents the supported Ops Console entrypoint default instead of treating an unset shell variable as unhealthy', () => {
    const source = readFileSync('scripts/dev-doctor.ts', 'utf8')
    expect(source).toContain("process.env.VITE_API_BASE?.trim()")
    expect(source).toContain("受支持的 npm run dev:ops-console 会注入 /api")
  })

  it('binds ECS production diagnosis to the real HTTPS endpoint and excludes local Compose evidence', () => {
    const source = readFileSync('scripts/dev-doctor.ts', 'utf8')
    expect(source).toContain("deploymentTarget === 'ecs'")
    expect(source).toContain('PRODUCTION_API_BASE_URL')
    expect(source).toContain('ECS 范围不以开发机 Compose 容器状态判断生产健康')
    expect(source).toContain('deploy-preflight-ecs.sh')
  })
})
