import { describe, expect, it, vi } from 'vitest'
import { OpenAICompatibleVideoGenerator, type VideoBillingContext } from './video-generator.js'

describe('asynchronous video actual usage settlement', () => {
  function fixture() {
    const sink = vi.fn(() => ({ recorded: true as const, costEvidence: true as const }))
    let statusPayload: unknown = { id: 'job-a', status: 'completed', video_url: 'https://cdn.example/a.mp4', usage: { duration_seconds: 4 } }
    const calls: string[] = []
    const generator = new OpenAICompatibleVideoGenerator({ baseUrl: 'https://relay.example', apiKey: 'test-only', model: 'video-model', resolution: '720P', durationSeconds: 5, usageSink: sink,
      fetch: async (_url, init) => {
        calls.push(init?.method ?? 'GET')
        return new Response(JSON.stringify(init?.method === 'POST' ? { id: 'job-a', status: 'queued' } : statusPayload), { headers: { 'x-request-id': init?.method === 'POST' ? 'generation-a' : `poll-${calls.length}` } })
      },
    })
    return { generator, sink, calls, setStatus: (payload: unknown) => { statusPayload = payload } }
  }
  const usageContext = { workspaceId: 'workspace-a', actionId: 'video:a', runKey: 'run:a' }
  it('persists accepted identity before returning pending, then meters actual duration under generation identity', async () => {
    const f = fixture(); let persisted: VideoBillingContext | undefined
    await expect(f.generator.generate({ prompt: 'test', output: 'rendering', context: {}, usageContext, onAccepted: async context => { persisted = structuredClone(context) } })).resolves.toMatchObject({ status: 'queued', settlementStatus: 'pending_receipt', providerJobId: 'job-a' })
    expect(persisted).toMatchObject({ ...usageContext, providerJobId: 'job-a', providerRequestId: 'generation-a', model: 'video-model', resolution: '720P' })
    expect(f.sink).not.toHaveBeenCalled()
    await expect(f.generator.getStatus('job-a', persisted)).resolves.toMatchObject({ status: 'completed', settlementStatus: 'settled' })
    await f.generator.getStatus('job-a', persisted)
    expect(f.calls).toEqual(['POST', 'GET', 'GET'])
    for (const [record] of f.sink.mock.calls as unknown as Array<[Record<string, unknown>]>) expect(record).toMatchObject({ ...usageContext, providerRequestId: 'generation-a', metadata: { duration_seconds: 4, duration_evidence: 'provider_usage', preauthorization_duration_seconds: 5 } })
  })
  it('does not deliver or call settlement when completed status lacks actual metering', async () => {
    const f = fixture(); let context: VideoBillingContext | undefined
    await f.generator.generate({ prompt: 'test', output: 'rendering', context: {}, usageContext, onAccepted: async value => { context = value } })
    f.setStatus({ id: 'job-a', status: 'completed', video_url: 'https://cdn.example/a.mp4' })
    const result = await f.generator.getStatus('job-a', context)
    expect(result).toEqual({ status: 'queued', providerJobId: 'job-a', settlementStatus: 'pending_receipt' })
    expect(f.sink).not.toHaveBeenCalled()
    expect(await f.generator.getStatus('job-a', { ...context!, settlementVerified: true })).toMatchObject({ status: 'completed', settlementStatus: 'settled' })
  })
  it.each([
    { duration_seconds: 3, output_video_duration: 8 },
    { duration_seconds: 'invalid', duration: 3 },
  ])('keeps contradictory duration evidence pending despite a previously verified settlement: %j', async duration => {
    const f = fixture()
    f.setStatus({ id: 'job-a', status: 'completed', video_url: 'https://cdn.example/a.mp4', usage: { ...duration, cost_cny: 0.5 } })
    for (const settlementVerified of [false, true]) {
      await expect(f.generator.getStatus('job-a', { ...usageContext, providerJobId: 'job-a', providerRequestId: 'generation-a', model: 'video-model', settlementVerified })).resolves.toEqual({
        status: 'queued', providerJobId: 'job-a', settlementStatus: 'pending_receipt',
      })
    }
    expect(f.sink).not.toHaveBeenCalled()
    expect(f.calls).toEqual(['GET', 'GET'])
  })
  it('retains provider-success semantics if accepted-job persistence fails', async () => {
    const f = fixture()
    await expect(f.generator.generate({ prompt: 'test', output: 'rendering', context: {}, usageContext, onAccepted: async () => { throw new Error('durability unavailable') } })).rejects.toMatchObject({ providerSucceeded: true, reconciliationRequired: true, providerJobId: 'job-a' })
    expect(f.calls).toEqual(['POST']); expect(f.sink).not.toHaveBeenCalled()
  })
  it('rejects provider job mismatch without settlement', async () => {
    const f = fixture()
    f.setStatus({ id: 'other-job', status: 'completed', video_url: 'https://cdn.example/a.mp4', usage: { duration_seconds: 4 } })
    await expect(f.generator.getStatus('job-a', { ...usageContext, providerJobId: 'job-a', providerRequestId: 'generation-a', model: 'video-model' })).rejects.toThrow('VIDEO_PROVIDER_JOB_ID_MISMATCH')
    expect(f.sink).not.toHaveBeenCalled()
  })
})
