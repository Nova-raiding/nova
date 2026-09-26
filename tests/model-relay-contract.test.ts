import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertProviderResponseAccepted } from '../packages/ai/src/provider-request.js'
import { OpenAICompatibleVideoGenerator } from '../packages/ai/src/video-generator.js'
import { assertSafeRelativePath, blockHttpProbe, buildVideoProbeRequest, canaryIdempotencyKey, canaryRetryDelayMs, canRetryCanaryResponse, evaluateRelayUsageEvidence, evaluateVideoProbePayload, extractProviderRequestId, finalizeSuccessfulProbe, persistRelayCanaryEvidence, readRelayErrorRecovery, requireCanaryBudget, requireFiniteRelayTokenQuota, requireProductionReleaseBinding, reserveCanaryCost, resolveBoundedInteger, shouldBlockForCostGuard, writeRelayResponseArtifact, writeRelayTokenQuotaArtifact } from '../scripts/model-relay-canary.js'
import { validateModelRelayEvidence } from './model-relay-evidence-gate.js'

describe('production model relay contract', () => {
  const completeProbe = (modality: 'text' | 'image' | 'image_edit' | 'ocr' | 'video') => ({
    modality,
    endpoint: '/probe',
    model: `${modality}-v1`,
    httpStatus: 200,
    providerRequestId: `req-${modality}`,
    usageObserved: true,
    usage: modality === 'text' || modality === 'ocr' ? { totalTokens: 1 } : modality === 'video' ? { durationSeconds: 5 } : { billingUnits: 1 },
    usageProviderRequestId: `req-${modality}`,
    costObserved: true,
    costSource: 'provider_receipt' as const,
    costCny: 0.01,
    responseValid: true,
  })

  it('loads an operator-captured recovery object without inventing recovery evidence', () => {
    expect(readRelayErrorRecovery(undefined)).toBeUndefined()
    const directory = mkdtempSync(join(tmpdir(), 'relay-recovery-'))
    const path = join(directory, 'recovery.json')
    writeFileSync(path, JSON.stringify({ verified: true, failure_status: 503 }))
    expect(readRelayErrorRecovery(path)).toEqual({ verified: true, failure_status: 503 })
    writeFileSync(path, '[]')
    expect(() => readRelayErrorRecovery(path)).toThrow('must contain one JSON object')
  })

  it.each(['image', 'image_edit', 'video'] as const)('requires explicit cost confirmation before billable %s probes', modality => {
    expect(shouldBlockForCostGuard({ modality, confirmCost: false })).toBe(true)
    expect(shouldBlockForCostGuard({ modality, confirmCost: true })).toBe(false)
  })

  it('allows polling an existing video job without re-confirming a new billable request', () => {
    expect(shouldBlockForCostGuard({ modality: 'video', confirmCost: false, existingVideoTaskId: 'job-existing' })).toBe(false)
  })

  it('requires an explicit per-run budget before any model request', () => {
    for (const value of [undefined, '', '0', '-1', 'NaN', 'Infinity']) expect(() => requireCanaryBudget(value)).toThrow('MODEL_RELAY_CANARY_MAX_TOTAL_CNY')
    expect(requireCanaryBudget('1.25')).toEqual({ limitCny: 1.25, reservedCny: 0 })
  })

  it('keeps partial production modality runs out of the final evidence path', () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-partial-evidence-'))
    const path = join(directory, 'final-evidence.json')
    const evidence = { schema_version: '1', release_id: 'release-1', results: [] }
    try {
      const partial = persistRelayCanaryEvidence({ path, environment: 'production', modalities: ['text', 'ocr'], evidence })
      expect(partial).toEqual({ evidence: { ...evidence, state: 'partial' }, state: 'partial', written: false, exitCode: 1 })
      expect(() => readFileSync(path, 'utf8')).toThrow()

      const duplicateCoverage = persistRelayCanaryEvidence({ path, environment: 'production', modalities: ['text', 'image', 'image_edit', 'ocr', 'ocr'], evidence })
      expect(duplicateCoverage).toMatchObject({ state: 'partial', written: false, exitCode: 1, evidence: { state: 'partial' } })
      expect(() => readFileSync(path, 'utf8')).toThrow()
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('does not occupy the final path when all five probes ran but evidence is blocked', () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-complete-evidence-'))
    const path = join(directory, 'final-evidence.json')
    const evidence = { schema_version: '1', release_id: 'release-1', results: [] }
    try {
      const persisted = persistRelayCanaryEvidence({ path, environment: 'production', modalities: ['text', 'image', 'image_edit', 'ocr', 'video'], evidence, artifactRoot: directory })
      expect(persisted).toEqual({ evidence: { ...evidence, state: 'partial' }, state: 'partial', written: false, exitCode: 1 })
      expect(() => readFileSync(path, 'utf8')).toThrow()
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('writes the final production path after the complete evidence gate passes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-valid-evidence-'))
    const path = join(directory, 'final-evidence.json')
    const releaseId = 'release-1'
    const relay = 'https://relay.example.test'
    const now = Date.now()
    const generatedAt = new Date(now).toISOString()
    const observedAt = new Date(now - 60_000).toISOString()
    const failureAt = new Date(now - 120_000).toISOString()
    const saveReceipt = (name: string, receipt: Record<string, unknown>) => {
      const body = JSON.stringify(receipt)
      const target = join(directory, 'relay', name)
      writeFileSync(target, body)
      return `artifact://production/relay/${name}#${createHash('sha256').update(body).digest('hex')}`
    }
    try {
      mkdirSync(join(directory, 'relay'))
      const results = (['text', 'image', 'image_edit', 'ocr', 'video'] as const).map(modality => {
        const result = { ...completeProbe(modality), state: 'ready' as const }
        const evidence_ref = saveReceipt(`${modality}.json`, {
          schema_version: '1', release_id: releaseId, modality, http_status: 200, result,
          ...(modality === 'video' ? { relay_response: { status: 'completed', output_url: 'https://cdn.example.test/video.mp4' } } : {}),
        })
        return { ...result, evidence_ref }
      })
      const token_quota = (['model', 'video'] as const).map(credential => {
        const quota = { credential, observed_at: observedAt, total_granted: 1000, total_used: 200, total_available: 800, expires_at: 0, unlimited_quota: false as const }
        return { ...quota, evidence_ref: saveReceipt(`token-${credential}.json`, { schema_version: '1', release_id: releaseId, token_quota: quota }) }
      })
      const error_recovery = {
        verified: true, failure_status: 503, failure_observed_at: failureAt, recovered_at: observedAt,
        failed_request_id: 'req-failed', recovery_request_id: 'req-recovered',
        evidence_ref: saveReceipt('recovery.json', {
          schema_version: '1', release_id: releaseId,
          failure: { release_id: releaseId, observed_at: failureAt, http_status: 503, error_code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', relay_response: { error: { code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN' } }, provider_request_id: 'req-failed', relay, endpoint: '/probe' },
          recovery: { release_id: releaseId, observed_at: observedAt, http_status: 200, provider_request_id: 'req-recovered', relay, endpoint: '/probe' },
        }),
      }
      const evidence = { schema_version: '1', release_id: releaseId, generated_at: generatedAt, expires_at: new Date(now + 3_600_000).toISOString(), environment: 'production', simulated: false, relay, token_quota, results, error_recovery }
      const persisted = persistRelayCanaryEvidence({ path, environment: 'production', modalities: ['text', 'image', 'image_edit', 'ocr', 'video'], evidence, artifactRoot: directory })
      expect(persisted).toEqual({ evidence, state: 'complete', written: true, exitCode: 0 })
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(evidence)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('requires a finite server-enforced relay token before any billable request', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ code: true, data: { object: 'token_usage', total_granted: 1000, total_used: 200, total_available: 800, unlimited_quota: false, expires_at: 0 } })))
    const input = { baseUrl: 'https://relay.example.test/v1', apiKey: 'test-key', credential: 'model' as const, fetcher, now: new Date('2026-09-23T00:00:00Z') }
    await expect(requireFiniteRelayTokenQuota(input)).resolves.toMatchObject({ credential: 'model', total_available: 800, unlimited_quota: false, observed_at: '2026-09-23T00:00:00.000Z' })
    expect(fetcher).toHaveBeenCalledWith(new URL('https://relay.example.test/api/usage/token/'), expect.objectContaining({ redirect: 'error', headers: expect.objectContaining({ authorization: 'Bearer test-key' }) }))
    for (const data of [
      { object: 'token_usage', total_granted: 0, total_used: 100, total_available: -100, unlimited_quota: true, expires_at: 0 },
      { object: 'token_usage', total_granted: 1000, total_used: 1000, total_available: 0, unlimited_quota: false, expires_at: 0 },
      { object: 'token_usage', total_granted: 1000, total_used: 200, total_available: 900, unlimited_quota: false, expires_at: 0 },
      { object: 'token_usage', total_granted: 1000, total_used: 200, total_available: 800, unlimited_quota: false, expires_at: 1 },
    ]) {
      fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ code: true, data })))
      await expect(requireFiniteRelayTokenQuota(input)).rejects.toThrow(/finite.*quota/u)
    }
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ code: false, data: { object: 'token_usage' } })))
    await expect(requireFiniteRelayTokenQuota(input)).rejects.toThrow('response is invalid')
    fetcher.mockResolvedValueOnce(new Response('{}', { status: 401 }))
    await expect(requireFiniteRelayTokenQuota(input)).rejects.toThrow('HTTP 401')
  })

  it('stores a finite token receipt by content hash without exposing its key', () => {
    const root = mkdtempSync(join(tmpdir(), 'relay-token-quota-'))
    try {
      const quota = { credential: 'model' as const, observed_at: '2026-09-23T00:00:00Z', total_granted: 1000, total_used: 200, total_available: 800, expires_at: 0, unlimited_quota: false as const }
      const reference = writeRelayTokenQuotaArtifact(root, 'release-1', quota)
      expect(reference).toMatch(/^artifact:\/\/production\/relay\/release-1\/token-model-[a-f0-9]{16}\.json#[a-f0-9]{64}$/u)
      const path = join(root, reference.slice('artifact://production/'.length).split('#')[0]!)
      expect(readFileSync(path, 'utf8')).toContain('"total_available": 800')
      expect(writeRelayTokenQuotaArtifact(root, 'release-1', quota)).toBe(reference)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('reserves three possible 429 attempts and rejects an over-budget probe before dispatch', async () => {
    const budget = requireCanaryBudget('0.59')
    const pricing = { estimateRequestCost: vi.fn(async () => ({ costCny: 0.2, metadata: { pricing_version: 'v1', pricing_group: 'VIP', quota_type: 1, formula_version: 'new-api-quota-v1' as const } })) }
    await expect(reserveCanaryCost({ pricing, budget, modality: 'image', model: 'image-1', requestBody: { n: 1 } })).rejects.toThrow('exceeds MODEL_RELAY_CANARY_MAX_TOTAL_CNY')
    expect(budget.reservedCny).toBe(0)
    budget.limitCny = 0.6
    await expect(reserveCanaryCost({ pricing, budget, modality: 'image', model: 'image-1', requestBody: { n: 1 } })).resolves.toBe(0.6)
    expect(budget.reservedCny).toBe(0.6)
  })

  it('rejects unknown or misleading media prices rather than treating an estimate as observed cost', async () => {
    const budget = requireCanaryBudget('10')
    const input = { budget, modality: 'image_edit' as const, model: 'edit-1', requestBody: { n: 1 } }
    await expect(reserveCanaryCost({ ...input, pricing: undefined })).rejects.toThrow('pricing snapshot is required')
    await expect(reserveCanaryCost({ ...input, pricing: { estimateRequestCost: async () => ({ costCny: 0, metadata: { pricing_version: 'v1', pricing_group: 'VIP', quota_type: 1, formula_version: 'new-api-quota-v1' as const } }) } })).rejects.toThrow('unknown or zero')
    await expect(reserveCanaryCost({ ...input, pricing: { estimateRequestCost: async () => ({ costCny: 0.1, metadata: { pricing_version: 'v1', pricing_group: 'VIP', quota_type: 0, formula_version: 'new-api-quota-v1' as const } }) } })).rejects.toThrow('fixed-unit')
    expect(budget.reservedCny).toBe(0)
  })

  it('requires an explicit priced video resolution and duration before reserving', async () => {
    const budget = requireCanaryBudget('10')
    const pricing = { estimateRequestCost: vi.fn(async () => ({ costCny: 0.75, metadata: { pricing_version: 'v1', pricing_group: 'VIP', quota_type: 1, formula_version: 'relay-video-cny-per-second-v1' as const } })) }
    const input = { pricing, budget, modality: 'video' as const, model: 'video-1', requestBody: { duration: 3 }, durationSeconds: 3 }
    await expect(reserveCanaryCost(input)).rejects.toThrow('explicit 720P/1080P resolution')
    expect(pricing.estimateRequestCost).not.toHaveBeenCalled()
    await expect(reserveCanaryCost({ ...input, resolution: '480P' })).rejects.toThrow('explicit 720P/1080P resolution')
    await expect(reserveCanaryCost({ ...input, resolution: '720P', durationSeconds: 16 })).rejects.toThrow('3-15 second duration')
    await expect(reserveCanaryCost({ ...input, resolution: '720P' })).resolves.toBe(2.25)
    expect(pricing.estimateRequestCost).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ preauthorization_duration_seconds: 3, resolution: '720P' }) }))
    expect(budget.reservedCny).toBe(2.25)
  })

  it('rejects fallback video ratio pricing and budgets bounded text tokens', async () => {
    const budget = requireCanaryBudget('1')
    const unsupported = { estimateRequestCost: async () => ({ costCny: 0.1, metadata: { pricing_version: 'v1', pricing_group: 'VIP', quota_type: 1, formula_version: 'new-api-quota-v1' as const } }) }
    await expect(reserveCanaryCost({ pricing: unsupported, budget, modality: 'video', model: 'video-1', requestBody: { duration: 3 }, durationSeconds: 3, resolution: '720P' })).rejects.toThrow('explicit duration/resolution relay price')
    const pricing = { estimateRequestCost: vi.fn(async () => ({ costCny: 0.01, metadata: { pricing_version: 'v1', pricing_group: 'VIP', quota_type: 0, formula_version: 'new-api-quota-v1' as const } })) }
    const requestBody = { model: 'text-1', max_tokens: 8, messages: [{ role: 'user', content: '只返回 OK' }] }
    await reserveCanaryCost({ pricing, budget, modality: 'text', model: 'text-1', requestBody })
    expect(pricing.estimateRequestCost).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: Buffer.byteLength(JSON.stringify(requestBody), 'utf8'), outputTokens: 8 }))
  })

  it.each([
    { environment: 'production', releaseId: '' },
    { environment: 'production', releaseId: '   ' },
  ])('fails closed when production evidence has no release binding', input => {
    expect(() => requireProductionReleaseBinding(input)).toThrow('RELEASE_ID is required for production model relay evidence')
  })

  it('does not require a release binding for non-production canaries', () => {
    expect(() => requireProductionReleaseBinding({ environment: 'test', releaseId: '' })).not.toThrow()
  })

  it('rejects unsafe production release identities before writing evidence', () => {
    for (const releaseId of ['../release', 'release/child', 'release\nspoofed']) {
      expect(() => requireProductionReleaseBinding({ environment: 'production', releaseId })).toThrow('safe production evidence identifier')
    }
  })

  it('rejects relay endpoint paths that the production evidence gate cannot accept', () => {
    expect(assertSafeRelativePath('/chat/completions')).toBe('/chat/completions')
    for (const path of ['//other-host/probe', '/v1/../probe', '/v1/./probe', '/v1/%2e%2e/probe', '/probe?model=other', '/probe#fragment', '/probe\\child']) {
      expect(() => assertSafeRelativePath(path)).toThrow('safe relative path')
    }
  })

  it('fails closed on malformed timeout and evidence TTL configuration', () => {
    for (const value of ['NaN', '1.5', '0', '120001']) {
      expect(() => resolveBoundedInteger(value, 120_000, 2_000, 120_000, 'MODEL_RELAY_CANARY_TIMEOUT_MS')).toThrow('MODEL_RELAY_CANARY_TIMEOUT_MS')
    }
    expect(resolveBoundedInteger(undefined, 120_000, 2_000, 120_000, 'MODEL_RELAY_CANARY_TIMEOUT_MS')).toBe(120_000)
    expect(resolveBoundedInteger(' 60000 ', 120_000, 2_000, 120_000, 'MODEL_RELAY_CANARY_TIMEOUT_MS')).toBe(60_000)
  })

  it('retries only explicit 429 rejection with bounded Retry-After', () => {
    expect(canRetryCanaryResponse(429, 1)).toBe(true)
    expect(canRetryCanaryResponse(429, 3)).toBe(false)
    for (const status of [408, 500, 502, 503, 504]) expect(canRetryCanaryResponse(status, 1)).toBe(false)
    expect(canaryRetryDelayMs(new Headers({ 'retry-after': '2' }), 1)).toBe(2_000)
    expect(canaryRetryDelayMs(new Headers({ 'retry-after': '999999' }), 1)).toBe(60_000)
  })

  it('binds a stable canary idempotency key to release, modality, model and video job', () => {
    const first = canaryIdempotencyKey({ releaseId: 'release-1', modality: 'video', model: 'video-v1', existingVideoTaskId: 'job-1' })
    expect(first).toMatch(/^model_relay_canary_[a-f0-9]{64}$/u)
    expect(canaryIdempotencyKey({ releaseId: 'release-1', modality: 'video', model: 'video-v1', existingVideoTaskId: 'job-1' })).toBe(first)
    expect(canaryIdempotencyKey({ releaseId: 'release-2', modality: 'video', model: 'video-v1', existingVideoTaskId: 'job-1' })).not.toBe(first)
    expect(canaryIdempotencyKey({ releaseId: 'release-1', modality: 'video', model: 'video-v1', existingVideoTaskId: 'job-2' })).not.toBe(first)
  })

  it('does not disguise a response or async job id as a provider request id', () => {
    expect(extractProviderRequestId({ id: 'completion_1', task_id: 'job_1' }, new Headers())).toBeUndefined()
    expect(extractProviderRequestId({ provider_request_id: 'provider_req_1' }, new Headers())).toBe('provider_req_1')
    expect(extractProviderRequestId({}, new Headers({ 'x-oneapi-request-id': 'header_req_1' }))).toBe('header_req_1')
    expect(extractProviderRequestId({ data: { task_id: 'job_1', data: { request_id: 'nested_request_1' } } }, new Headers())).toBe('nested_request_1')
    expect(extractProviderRequestId({ data: { result: { request_id: 'envelope_request_1' } } }, new Headers())).toBe('envelope_request_1')
  })

  it('keeps provider image cost but leaves usage pending when provider units are absent', async () => {
    await expect(evaluateRelayUsageEvidence(
      { data: [{ url: 'https://cdn.example/image.png' }], cost_cny: 0.02 },
      new Headers({ 'x-request-id': 'req-image' }),
      'image',
      'image-v1',
    )).resolves.toEqual({ usageObserved: false, costObserved: true, costSource: 'provider_receipt', costCny: 0.02 })
  })

  it('uses only provider reported image units as fixed-price usage evidence', async () => {
    const pricing = { quote: async () => ({ costCny: 0.12, metadata: {
      cost_source: 'relay_pricing_snapshot' as const, pricing_version: 'pricing-v1', pricing_group: 'VIP', group_ratio: 1,
      usd_exchange_rate: 7, quota_per_unit: 500_000, quota_type: 1, model_ratio: 0, model_price: 0.12,
      completion_ratio: 1, raw_quota: 60_000, rounded_quota: 60_000, formula_version: 'new-api-quota-v1' as const,
    } }) }
    await expect(evaluateRelayUsageEvidence(
      { usage: { output_image_count: 1 }, data: [{ url: 'https://cdn.example/image.png' }] },
      new Headers({ 'x-request-id': 'req-image' }),
      'image',
      'image-v1',
      { pricing },
    )).resolves.toEqual({ usageObserved: true, usage: { billingUnits: 1 }, usageProviderRequestId: 'req-image', costObserved: true, costSource: 'relay_pricing_snapshot', costCny: 0.12, pricingVersion: 'pricing-v1', pricingGroup: 'VIP' })
  })

  it.each([0, -1, 1.5, '1x'])('does not use malformed or non-positive provider image count %p', async count => {
    const pricing = { quote: vi.fn() }
    await expect(evaluateRelayUsageEvidence(
      { usage: { output_image_count: count }, data: [{ url: 'https://cdn.example/image.png' }] },
      new Headers({ 'x-request-id': 'req-image-invalid' }),
      'image', 'image-v1', { pricing },
    )).resolves.toEqual({ usageObserved: false, costObserved: false })
    expect(pricing.quote).not.toHaveBeenCalled()
  })

  it('requires a numeric non-negative provider cost receipt', async () => {
    await expect(evaluateRelayUsageEvidence(
      { usage: { total_tokens: 1 }, cost_cny: 'not-a-number' },
      new Headers(),
      'text',
      'text-v1',
    )).resolves.toEqual({ usageObserved: true, usage: { totalTokens: 1 }, costObserved: false })
  })

  it('blocks queued and failed async video states until an HTTPS artifact is complete', () => {
    expect(evaluateVideoProbePayload({ task_id: 'job_queued', status: 'queued' })).toMatchObject({ ready: false, providerJobId: 'job_queued', reason: 'video_async_pending' })
    expect(evaluateVideoProbePayload({ task_id: 'job_in_progress', status: 'IN_PROGRESS' })).toMatchObject({ ready: false, providerJobId: 'job_in_progress', reason: 'video_async_pending' })
    expect(evaluateVideoProbePayload({ task_id: 'job_failed', status: 'failed' })).toMatchObject({ ready: false, providerJobId: 'job_failed', reason: 'video_async_failed' })
    expect(evaluateVideoProbePayload({ task_id: 'job_failure', status: 'FAILURE', result_url: 'task failed' })).toMatchObject({ ready: false, providerJobId: 'job_failure', reason: 'video_async_failed' })
    expect(evaluateVideoProbePayload({ task_id: 'job_done', status: 'completed', output_url: 'https://cdn.example/video.mp4' })).toEqual({ ready: true, providerJobId: 'job_done' })
    expect(evaluateVideoProbePayload({ task_id: 'job_no_status', output_url: 'https://cdn.example/video.mp4' })).toMatchObject({ ready: false, providerJobId: 'job_no_status', reason: 'video_async_state_missing' })
    expect(evaluateVideoProbePayload({ data: { task_id: 'job_conflict', status: 'SUCCESS', data: { task_status: 'RUNNING', output: { url: 'https://cdn.example/video.mp4' } } } })).toMatchObject({ ready: false, providerJobId: 'job_conflict', reason: 'video_async_state_conflict' })
    expect(evaluateVideoProbePayload({ task_id: 'job_bad_url', status: 'SUCCESS', output_url: 'https://' })).toMatchObject({ ready: false, providerJobId: 'job_bad_url', reason: 'video_completed_without_https_artifact' })
    expect(evaluateVideoProbePayload({ task_id: 'job_userinfo_url', status: 'SUCCESS', output_url: 'https://user:secret@cdn.example/video.mp4' })).toMatchObject({ ready: false, providerJobId: 'job_userinfo_url', reason: 'video_completed_without_https_artifact' })
    expect(evaluateVideoProbePayload({ code: 0, message: 'ok', data: { task_id: 'job_nested', status: 'SUCCESS', result_url: 'https://cdn.example/result.mp4', quota: 123, data: { request_id: 'request_nested', usage: { duration_seconds: 5 } } } })).toEqual({ ready: true, providerJobId: 'job_nested' })
    expect(evaluateVideoProbePayload({ code: 'success', data: { task_id: 'job_string_success', status: 'SUCCESS', result_url: 'https://cdn.example/result.mp4' } })).toEqual({ ready: true, providerJobId: 'job_string_success' })
    expect(evaluateVideoProbePayload({ data: { task_id: 'job_output', status: 'SUCCESS', data: { output: { url: 'https://cdn.example/output.mp4' } } } })).toEqual({ ready: true, providerJobId: 'job_output' })
    expect(evaluateVideoProbePayload({ code: 'success', data: { task_id: 'job_new_api', data: { task_status: 'RUNNING', task_id: 'upstream-task' } } })).toEqual({ ready: false, providerJobId: 'job_new_api', reason: 'video_async_pending' })
    expect(evaluateVideoProbePayload({ code: 'success', data: { task_id: 'job_real_new_api', data: { output: { task_status: 'RUNNING', task_id: 'upstream-task' } } } })).toEqual({ ready: false, providerJobId: 'job_real_new_api', reason: 'video_async_pending' })
    expect(evaluateVideoProbePayload({ code: 5001, data: { task_id: 'job_error', status: 'SUCCESS', result_url: 'https://cdn.example/stale.mp4' } })).toEqual({ ready: false, providerJobId: 'job_error', reason: 'video_relay_error_code' })
  })

  it('builds the existing openai-video multipart contract without overriding its boundary', () => {
    const request = buildVideoProbeRequest({
      model: 'wan3.0-video',
      prompt: 'canary',
      durationSeconds: 5,
      resolution: '720P',
      requestFormat: 'openai-video',
    })
    expect(request.contentType).toBeUndefined()
    expect(request.body).toBeInstanceOf(FormData)
    const form = request.body as FormData
    expect(form.get('model')).toBe('wan3.0-video')
    expect(form.get('prompt')).toBe('canary')
    expect(form.get('seconds')).toBe('5')
    expect(form.get('size')).toBe('720P')
    expect(form.get('duration')).toBeNull()
  })

  it('preserves the legacy JSON video contract when openai-video is not configured', () => {
    const request = buildVideoProbeRequest({ model: 'video-v1', prompt: 'canary', durationSeconds: 5 })
    expect(request.contentType).toBe('application/json')
    expect(JSON.parse(request.body as string)).toEqual({ model: 'video-v1', prompt: 'canary', duration: 5 })
  })

  it('keeps an async pending video canary blocked even when usage and cost exist', () => {
    expect(finalizeSuccessfulProbe({
      ...completeProbe('video'),
      providerJobId: 'job_pending',
      responseValid: false,
      responseFailure: 'video_async_pending',
    })).toMatchObject({ state: 'blocked', providerJobId: 'job_pending', detail: 'video_async_pending' })
  })

  it('keeps a nominally valid probe blocked unless HTTP status is successful', () => {
    expect(finalizeSuccessfulProbe({ ...completeProbe('text'), httpStatus: 503 })).toMatchObject({ state: 'blocked', detail: 'successful_http_status_missing' })
    expect(finalizeSuccessfulProbe({ ...completeProbe('text'), httpStatus: undefined })).toMatchObject({ state: 'blocked', detail: 'successful_http_status_missing' })
  })

  it('keeps OCR 503 as an explicit HTTP failure rather than success evidence', () => {
    expect(blockHttpProbe({ modality: 'ocr', endpoint: '/chat/completions', model: 'ocr-v1' }, 503, 'req-ocr')).toEqual({
      modality: 'ocr', endpoint: '/chat/completions', model: 'ocr-v1', state: 'blocked', httpStatus: 503,
      providerRequestId: 'req-ocr', usageObserved: false, costObserved: false, detail: 'relay returned HTTP 503',
    })
  })

  it.each(['text', 'image', 'image_edit', 'ocr', 'video'] as const)(
    'fails %s closed when request identity, usage, or cost evidence is missing',
    modality => {
      expect(finalizeSuccessfulProbe({ ...completeProbe(modality), providerRequestId: undefined })).toMatchObject({ state: 'blocked', detail: 'provider_request_id_missing' })
      expect(finalizeSuccessfulProbe({ ...completeProbe(modality), usageObserved: false })).toMatchObject({ state: 'blocked', detail: 'usage_evidence_missing' })
      expect(finalizeSuccessfulProbe({ ...completeProbe(modality), usage: undefined })).toMatchObject({ state: 'blocked', detail: 'numeric_usage_evidence_missing' })
      expect(finalizeSuccessfulProbe({ ...completeProbe(modality), usageProviderRequestId: 'different-request' })).toMatchObject({ state: 'blocked', detail: 'usage_request_id_mismatch' })
      expect(finalizeSuccessfulProbe({ ...completeProbe(modality), costObserved: false, costCny: undefined })).toMatchObject({ state: 'blocked', detail: 'cost_evidence_missing' })
    },
  )

  it.each(['text', 'image', 'image_edit', 'ocr', 'video'] as const)('marks %s ready only with complete attributable evidence', modality => {
    expect(finalizeSuccessfulProbe(completeProbe(modality))).toMatchObject({ state: 'ready' })
  })

  it.each([
    ['text', { billingUnits: 1 }, 'token_usage_evidence_missing'],
    ['ocr', { durationSeconds: 1 }, 'token_usage_evidence_missing'],
    ['image', { billingUnits: 0 }, 'billing_unit_evidence_missing'],
    ['image_edit', { billingUnits: 1.5 }, 'billing_unit_evidence_missing'],
    ['video', { durationSeconds: 0 }, 'duration_evidence_missing'],
  ] as const)('keeps %s blocked when its modality-specific usage evidence is invalid', (modality, usage, detail) => {
    expect(finalizeSuccessfulProbe({ ...completeProbe(modality), usage })).toMatchObject({ state: 'blocked', detail })
  })

  it('rejects malformed numeric evidence and inconsistent token totals before reporting ready', () => {
    expect(finalizeSuccessfulProbe({ ...completeProbe('text'), usage: { totalTokens: Number.NaN } })).toMatchObject({ state: 'blocked', detail: 'numeric_usage_evidence_missing' })
    expect(finalizeSuccessfulProbe({ ...completeProbe('text'), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 3 } })).toMatchObject({ state: 'blocked', detail: 'token_usage_evidence_inconsistent' })
    expect(finalizeSuccessfulProbe({ ...completeProbe('text'), costCny: -0.01 })).toMatchObject({ state: 'blocked', detail: 'cost_evidence_missing' })
  })

  it('requires immutable pricing identity when cost is derived from a relay snapshot', () => {
    expect(finalizeSuccessfulProbe({ ...completeProbe('text'), costSource: 'relay_pricing_snapshot' })).toMatchObject({ state: 'blocked', detail: 'pricing_snapshot_identity_missing' })
    expect(finalizeSuccessfulProbe({ ...completeProbe('text'), costSource: 'relay_pricing_snapshot', pricingVersion: 'pricing-v1', pricingGroup: 'default' })).toMatchObject({ state: 'ready' })
  })

  it('reads nested relay usage but never treats unversioned quota as CNY', async () => {
    await expect(evaluateRelayUsageEvidence(
      { data: { quota: 12345, data: { request_id: 'request_nested', usage: { duration_seconds: 5, billed_units: 1 } } } },
      new Headers(),
      'video',
      'video-v1',
    )).resolves.toEqual({ usageObserved: true, usage: { durationSeconds: 5 }, usageProviderRequestId: 'request_nested', costObserved: false })
  })

  it.each([
    ['duration with explicit seconds', { duration: 5, duration_unit: 'seconds' }],
    ['duration corroborated by output duration', { duration: 5, output_video_duration: 5 }],
    ['output_video_duration', { output_video_duration: '5' }],
    ['duration_seconds', { duration_seconds: 5 }],
    ['durationSeconds', { durationSeconds: 5 }],
  ] as const)('accepts positive provider video seconds from %s and binds them to pricing evidence', async (_field, usage) => {
    const quote = vi.fn(async () => ({ costCny: 1.25, metadata: {
      cost_source: 'relay_pricing_snapshot' as const, pricing_version: 'pricing-v2', pricing_group: 'VIP', group_ratio: 1,
      usd_exchange_rate: 7, quota_per_unit: 500_000, quota_type: 1, model_ratio: 1, model_price: 0,
      completion_ratio: 1, raw_quota: 1, rounded_quota: 1, formula_version: 'new-api-quota-v1' as const,
    } }))
    await expect(evaluateRelayUsageEvidence(
      { data: { data: { request_id: 'request-video-real', usage } } },
      new Headers(),
      'video',
      'wan3.0-video',
      { pricing: { quote } },
    )).resolves.toMatchObject({ usageObserved: true, usage: { durationSeconds: 5 }, usageProviderRequestId: 'request-video-real', costObserved: true, costCny: 1.25 })
    expect(quote).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ duration_seconds: 5, duration_evidence: 'provider_usage' }) }))
  })

  it.each([
    ['zero duration', { duration: 0 }],
    ['negative duration', { output_video_duration: -1 }],
    ['generic duration without unit or corroboration', { duration: 5 }],
    ['generic duration explicitly in milliseconds', { duration: 5000, duration_unit: 'ms' }],
    ['output duration with non-seconds unit', { output_video_duration: 5000, unit: 'milliseconds' }],
    ['wrong unit field', { duration_ms: 5000 }],
    ['conflicting seconds', { duration: 5, output_video_duration: 6 }],
  ])('rejects invalid provider video duration evidence: %s', async (_case, usage) => {
    const quote = vi.fn()
    await expect(evaluateRelayUsageEvidence(
      { data: { data: { request_id: 'request-video-invalid', usage } } },
      new Headers(),
      'video',
      'wan3.0-video',
      { pricing: { quote } },
    )).resolves.toEqual({ usageObserved: false, costObserved: false })
    expect(quote).not.toHaveBeenCalled()
  })

  it('never prices video from request duration when provider duration is invalid even if token usage exists', async () => {
    const quote = vi.fn(async () => { throw new Error('pricing must not be called') })
    await expect(evaluateRelayUsageEvidence(
      { data: { data: { request_id: 'request-video-token-only', usage: { total_tokens: 9, duration: 5000, duration_unit: 'ms' } } } },
      new Headers(),
      'video',
      'wan3.0-video',
      { durationSeconds: 5, pricing: { quote } },
    )).resolves.toEqual({ usageObserved: true, usage: { totalTokens: 9 }, usageProviderRequestId: 'request-video-token-only', costObserved: false })
    expect(quote).not.toHaveBeenCalled()
  })

  it('normalizes the real provider SR payload and uses only output resolution for pricing', async () => {
    const quote = vi.fn(async () => ({ costCny: 5.10884, metadata: {
      cost_source: 'relay_pricing_snapshot' as const, pricing_version: 'a42d372ccf0b5dd13ecf71203521f9d2', pricing_group: 'VIP', group_ratio: 1,
      usd_exchange_rate: 6.83, quota_per_unit: 500_000, quota_type: 1, model_ratio: 1, model_price: 0,
      completion_ratio: 1, raw_quota: 374_000, rounded_quota: 374_000, formula_version: 'relay-video-resolution-v1' as const,
    } }))
    await expect(evaluateRelayUsageEvidence(
      { code: 200, data: { task_id: 'job-real', status: 'SUCCESS', result_url: 'https://cdn.example/video.mp4', data: { request_id: 'request-real', usage: { SR: 1080, duration: 5, output_video_duration: 5, fps: 30, video_count: 1 } } } },
      new Headers(),
      'video',
      'wan3.0-video',
      { resolution: '720P', pricing: { quote } },
    )).resolves.toMatchObject({ usageObserved: true, usage: { durationSeconds: 5 }, costObserved: true, costCny: 5.10884, pricingVersion: 'a42d372ccf0b5dd13ecf71203521f9d2', pricingGroup: 'VIP' })
    expect(quote).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ duration_seconds: 5, duration_evidence: 'provider_usage', resolution: '1080P' }) }))
  })

  it.each([
    ['unknown SR', { SR: 1440 }],
    ['conflicting output resolutions', { SR: 1080, output_resolution: '720P' }],
  ])('refuses pricing for %s instead of falling back to requested resolution', async (_case, resolutionUsage) => {
    const quote = vi.fn()
    await expect(evaluateRelayUsageEvidence(
      { data: { data: { request_id: 'request-resolution-invalid', usage: { duration_seconds: 5, ...resolutionUsage } } } },
      new Headers(),
      'video',
      'wan3.0-video',
      { resolution: '1080P', pricing: { quote } },
    )).resolves.toEqual({ usageObserved: true, usage: { durationSeconds: 5 }, usageProviderRequestId: 'request-resolution-invalid', costObserved: false })
    expect(quote).not.toHaveBeenCalled()
  })

  it('does not treat requested video duration as observed provider usage', async () => {
    await expect(evaluateRelayUsageEvidence(
      { data: { request_id: 'req-video', task_id: 'job-video', status: 'completed', result_url: 'https://cdn.example/video.mp4' }, cost_cny: 0.02 },
      new Headers(),
      'video',
      'video-v1',
      { durationSeconds: 5 },
    )).resolves.toEqual({ usageObserved: false, costObserved: true, costSource: 'provider_receipt', costCny: 0.02 })
  })

  it('reads usage from the API envelope result without requiring real relay configuration', async () => {
    await expect(evaluateRelayUsageEvidence(
      { data: { result: { request_id: 'envelope_request_1', usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, cost_cny: 0.03 } } } },
      new Headers(),
      'text',
      'relay-text',
    )).resolves.toMatchObject({ usageObserved: true, costObserved: true, costCny: 0.03, costSource: 'provider_receipt' })
  })

  it('treats relay gateway failures as unknown outcomes requiring reconciliation', () => {
    expect(() => assertProviderResponseAccepted(new Response('', { status: 502 }), 'model_provider_test', 'image provider')).toThrow(expect.objectContaining({
      code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN',
      providerOutcome: 'unknown',
      reconciliationRequired: true,
      retryable: false,
    }))
  })

  it('classifies video status transport and gateway failures without marking the job failed', async () => {
    const generator = new OpenAICompatibleVideoGenerator({
      baseUrl: 'https://relay.example',
      apiKey: 'redacted-test-value',
      model: 'video-v1',
      fetch: (async () => new Response('', { status: 503 })) as typeof fetch,
    })
    await expect(generator.getStatus('job_1')).rejects.toMatchObject({
      code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN',
      providerOutcome: 'unknown',
      reconciliationRequired: true,
    })
  })

  it('rejects production evidence without attributable cost source and pricing snapshot identity', () => {
    const results = ['text', 'image', 'image_edit', 'ocr', 'video'].map(modality => ({
      modality,
      state: 'ready',
      endpoint: '/probe',
      model: `${modality}-v1`,
      providerRequestId: `req-${modality}`,
      usageObserved: true,
      costObserved: true,
      costCny: 0.01,
    }))
    const errors = validateModelRelayEvidence({
      schema_version: '1',
      release_id: 'release-1',
      generated_at: new Date().toISOString(),
      environment: 'production',
      simulated: false,
      relay: 'https://relay.example',
      results,
    }, { requireProduction: true })
    expect(errors).toEqual(expect.arrayContaining([
      'text.costSource must identify provider_receipt or relay_pricing_snapshot',
      'video.costSource must identify provider_receipt or relay_pricing_snapshot',
    ]))
  })

  it('binds a real relay response to an immutable release artifact', () => {
    const root = mkdtempSync(join(tmpdir(), 'relay-artifacts-'))
    try {
      const result = completeProbe('text')
      const reference = writeRelayResponseArtifact(root, 'release-1', 'text', {
        status: 200,
        headers: new Headers({ 'x-request-id': 'req-text' }),
        payload: { choices: [{ message: { content: 'OK' } }], usage: { total_tokens: 2 } },
        result: { ...result, state: 'ready' },
      })
      const artifactPath = join(root, 'relay/release-1/text.json')
      const body = readFileSync(artifactPath, 'utf8')
      const digest = createHash('sha256').update(body).digest('hex')
      expect(reference).toBe(`artifact://production/relay/release-1/text.json#${digest}`)
      expect(validateModelRelayEvidence({
        schema_version: '1', release_id: 'release-1', generated_at: '2026-08-26T01:00:00Z',
        expires_at: '2099-08-26T01:00:00Z', environment: 'production', simulated: false,
        relay: 'https://relay.example.com', results: [{ ...result, evidence_ref: reference }],
      }, { expectedReleaseId: 'release-1', requireProduction: true, artifactRoot: root })).toEqual(expect.arrayContaining([
        'image result is required', 'image_edit result is required', 'ocr result is required', 'video result is required',
      ]))
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('rejects a ready summary whose artifact has a different HTTP status', () => {
    const root = mkdtempSync(join(tmpdir(), 'relay-http-status-binding-'))
    try {
      const result = completeProbe('text')
      const reference = writeRelayResponseArtifact(root, 'release-1', 'text', {
        status: 503,
        headers: new Headers({ 'x-request-id': 'req-text' }),
        payload: { choices: [{ message: { content: 'OK' } }], usage: { total_tokens: 2 } },
        result: { ...result, state: 'ready' },
      })
      const errors = validateModelRelayEvidence({
        schema_version: '1', release_id: 'release-1', generated_at: new Date().toISOString(),
        environment: 'production', simulated: false, relay: 'https://relay.example.com',
        results: [{ ...result, evidence_ref: reference }],
      }, { requireProduction: true, artifactRoot: root })
      expect(errors).toContain('text.evidence_ref receipt must bind successful HTTP status and summarized request, model, state, endpoint, usage and cost')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it.each([
    ['outer success with nested running state', { data: { status: 'SUCCESS', data: { task_status: 'RUNNING', output: { url: 'https://cdn.example/video.mp4' } } } }],
    ['completed task with HTTPS userinfo URL', { task_id: 'job-userinfo', status: 'SUCCESS', output_url: 'https://user:secret@cdn.example/video.mp4' }],
    ['completed task with only an unrelated metadata docs URL', { data: { status: 'SUCCESS', data: { output: { metadata: { docs_url: 'https://docs.example/provider' } } } } }],
  ])('rejects video receipts with %s', (_label, payload) => {
    const root = mkdtempSync(join(tmpdir(), 'relay-video-completion-binding-'))
    try {
      const result = completeProbe('video')
      const reference = writeRelayResponseArtifact(root, 'release-1', 'video', {
        status: 200,
        headers: new Headers({ 'x-request-id': 'req-video' }),
        payload,
        result: { ...result, state: 'ready' },
      })
      const errors = validateModelRelayEvidence({
        schema_version: '1', release_id: 'release-1', generated_at: new Date().toISOString(),
        environment: 'production', simulated: false, relay: 'https://relay.example.com',
        results: [{ ...result, state: 'ready', evidence_ref: reference }],
      }, { requireProduction: true, artifactRoot: root })
      expect(errors).toContain('video.evidence_ref video receipt must prove a completed task with an HTTPS artifact')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('persists provider failure responses as auditable artifacts', () => {
    const root = mkdtempSync(join(tmpdir(), 'relay-failure-artifacts-'))
    try {
      const reference = writeRelayResponseArtifact(root, 'release-1', 'video', {
        status: 503,
        headers: new Headers({ 'x-request-id': 'req-video-503' }),
        payload: { error: { code: 'model_not_found' } },
        result: { modality: 'video', endpoint: '/video/generations', model: 'video-v1', state: 'blocked', httpStatus: 503, providerRequestId: 'req-video-503', usageObserved: false, costObserved: false, detail: 'relay returned HTTP 503' },
      })
      const body = JSON.parse(readFileSync(join(root, 'relay/release-1/video.json'), 'utf8')) as Record<string, any>
      expect(reference).toMatch(/^artifact:\/\/production\/relay\/release-1\/video\.json#[a-f0-9]{64}$/u)
      expect(body.http_status).toBe(503)
      expect(body.result.providerRequestId).toBe('req-video-503')
      expect(body.relay_response.error.code).toBe('model_not_found')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('never overwrites an existing release artifact with a different response', () => {
    const root = mkdtempSync(join(tmpdir(), 'relay-immutable-artifacts-'))
    try {
      const first = writeRelayResponseArtifact(root, 'release-1', 'text', {
        status: 200,
        headers: new Headers({ 'x-request-id': 'req-first' }),
        payload: { choices: [{ message: { content: 'OK' } }], usage: { total_tokens: 2 } },
        result: { ...completeProbe('text'), state: 'ready' },
      })
      const second = writeRelayResponseArtifact(root, 'release-1', 'text', {
        status: 200,
        headers: new Headers({ 'x-request-id': 'req-second' }),
        payload: { choices: [{ message: { content: 'DIFFERENT' } }], usage: { total_tokens: 3 } },
        result: { ...completeProbe('text'), providerRequestId: 'req-second', state: 'ready' },
      })
      expect(second).not.toBe(first)
      expect(readFileSync(join(root, 'relay/release-1/text.json'), 'utf8')).toContain('req-first')
      expect(second).toMatch(/^artifact:\/\/production\/relay\/release-1\/text-[a-f0-9]{16}\.json#[a-f0-9]{64}$/u)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
