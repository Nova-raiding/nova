import { createHash } from 'node:crypto'
import { imageArchiveReceiptDigest, type VisualGenerationOutput } from '../../../packages/application/src/service.js'
import { describe, expect, it, vi } from 'vitest'
import { postImageGenerationResult } from './main.js'
import { handleInternalRuntimeRoute } from '../../api/src/http-internal-runtime-routes.js'
import type { InternalRuntimeContext } from '../../api/src/server.js'
import { MemoryImageGenerationExecutionRepository } from '../../../packages/persistence/src/image-generation-execution-repository.js'
import type { DurableOutboxEvent } from '../../../packages/workers/src/durable.js'

// Actual worker HTTP adapter and API result handler share a real execution
// state machine. Only auth, archival I/O and response transport are fixtures.
describe('image callback completion ownership', () => {
  it.each([true, false])('API owns the terminal lease when outputs are clean=%s', async clean => {
    const repository = new MemoryImageGenerationExecutionRepository()
    const event: DurableOutboxEvent = { id: 'event', workspaceId: 'ws', aggregateId: 'job', eventType: 'image.generation.requested', sequence: 1, payload: { intent_hash: 'a'.repeat(64) }, createdAt: new Date().toISOString() }
    const leased = await repository.claim({ workspaceId: 'ws', jobId: 'job', eventId: 'event', leaseMs: 60000 })
    const owned = { workspaceId: 'ws', jobId: 'job', ownerToken: leased.ownerToken }
    await repository.reserveProviderOperation(owned)
    await repository.beginProviderDispatch(owned)
    await repository.markProviderStarted({ ...owned, providerRequestId: 'provider-request' })
    const job = { id: 'job', workspaceId: 'ws', intentHash: 'a'.repeat(64), outputs: [] as VisualGenerationOutput[], state: 'running', archiveState: 'pending' }
    const completed = vi.spyOn(repository, 'markCompleted')
    const persisted = vi.fn()
    const charged = vi.fn()
    const calls: string[] = []
    let replayOverrides: Record<string, unknown> = {}
    const output = { ordinal: 1, assetId: 'asset', archiveReceiptId: 'receipt', visualRef: 'visual', storageKey: 'key', createdAt: new Date().toISOString(), reviewStatus: 'unreviewed' as const, mimeType: 'image/png', sizeBytes: 1, sha256: createHash('sha256').update('h').digest('hex') }
    const receipt = imageArchiveReceiptDigest({ ...output, workspaceId: 'ws', jobId: 'job', objectSha256: output.sha256 })
    const fetcher: typeof fetch = async (url, init) => {
      calls.push(String(url))
      let response: Response | undefined
      const context = {
        req: { method: 'POST' }, res: {}, path: new URL(String(url)).pathname,
        requireWorkerAuthorization: vi.fn(), headerRequired: () => 'ws', hydrateWorkspace: vi.fn(), enrichRequestObservation: vi.fn(),
        body: async () => ({ ...JSON.parse(String(init?.body)), ...replayOverrides }),
        service: { getImageGenerationJob: () => job },
        persistence: { imageGenerationExecutions: repository, outbox: { listAggregateEvents: async () => [event] } },
        requireChargedImageDeliveryEvidence: charged, persistImageGenerationCompletion: persisted,
        imageJobOutputsAreClean: () => clean,
        archiveGeneratedImages: async () => Object.assign(job, { outputs: [{ ...output, archiveReceiptDigest: receipt }], state: clean ? 'succeeded' : 'running', archiveState: clean ? 'archived' : 'pending_scan' }),
        send: (_res: unknown, status: number, _workspace: string, data: unknown) => { response = Response.json({ data }, { status }); return true },
      } as unknown as InternalRuntimeContext
      await handleInternalRuntimeRoute(context)
      return response!
    }
    await expect(postImageGenerationResult({ apiBaseUrl: 'https://api.example.test', apiToken: 'fixture', event,
      result: { intent_hash: job.intentHash, owner_token: leased.ownerToken, provider_request_id: 'provider-request', images: ['data:image/png;base64,aA=='] }, fetcher })).resolves.toBeUndefined()
    expect(calls).toEqual(['https://api.example.test/v1/internal/image-generation-jobs/job/result'])
    expect(charged).toHaveBeenCalledOnce()
    expect(persisted).toHaveBeenCalledOnce()
    expect(completed).toHaveBeenCalledTimes(clean ? 1 : 0)
    const execution = await repository.get(owned)
    expect(execution?.state).toBe(clean ? 'completed' : 'provider_started')
    expect(execution?.ownerToken).toBe(clean ? undefined : leased.ownerToken)
    // Lost response redelivery must not archive, persist or complete twice.
    const replay = () => postImageGenerationResult({ apiBaseUrl: 'https://api.example.test', apiToken: 'fixture', event,
      result: { intent_hash: job.intentHash, owner_token: leased.ownerToken, provider_request_id: 'provider-request', images: ['data:image/png;base64,aA=='] }, fetcher })
    await expect(replay()).resolves.toBeUndefined()
    expect(completed).toHaveBeenCalledTimes(clean ? 1 : 0)
    expect(persisted).toHaveBeenCalledTimes(clean ? 1 : 2)
    expect(charged).toHaveBeenCalledTimes(2)
    for (const override of [{ provider_request_id: 'other' }, { event_id: 'other' }, { intent_hash: 'b'.repeat(64) }, { images: ['data:image/png;base64,eA=='] }, { images: ['data:image/png;base64,aA==', 'data:image/png;base64,aA=='] }]) {
      replayOverrides = override
      await expect(replay()).rejects.toThrow()
    }
    replayOverrides = {}
    charged.mockRejectedValueOnce(new Error('settlement evidence missing'))
    await expect(replay()).rejects.toThrow('settlement evidence missing')
    job.outputs[0]!.archiveReceiptDigest = 'tampered'
    await expect(replay()).rejects.toThrow()
    expect(completed).toHaveBeenCalledTimes(clean ? 1 : 0)
    // Reproduce the exact old failure after an already-accepted callback.
    if (clean) await expect(repository.markCompleted(owned)).rejects.toMatchObject({ code: 'IMAGE_GENERATION_EXECUTION_LEASE_LOST' })
  })
})
