import { describe, expect, it, vi } from 'vitest'
import { submitTaskFeedbackIdempotently } from './task-feedback-idempotency.js'

function fixture() {
  const records = new Map<string, { requestHash: string; feedback: Record<string, unknown> }>()
  const service = {
    prepareFeedback: vi.fn((input: Record<string, unknown>, id: string) => ({ ...input, id, createdAt: '2026-10-11T00:00:00.000Z', revision: 1 })),
    submitFeedback: vi.fn(),
    hydrateSnapshot: vi.fn(),
  }
  const repository = {
    submit: vi.fn(async (input: { workspaceId: string; keyHash: string; requestHash: string; feedback: Record<string, unknown> }) => {
      const key = `${input.workspaceId}:${input.keyHash}`
      const existing = records.get(key)
      if (existing) {
        if (existing.requestHash !== input.requestHash) throw Object.assign(new Error('same key different intent'), { code: 'IDEMPOTENCY_KEY_REUSED' })
        return { feedback: existing.feedback, replayed: true }
      }
      records.set(key, { requestHash: input.requestHash, feedback: input.feedback })
      return { feedback: input.feedback, replayed: false }
    }),
  }
  return { service, repository }
}

describe('task feedback idempotency request boundary', () => {
  it('replays the durable result for the same workspace/key/payload and rejects changed payload', async () => {
    const f = fixture()
    const submit = (reason = 'clear product facts', workspaceId = 'ws-a') => submitTaskFeedbackIdempotently({
      service: f.service as never, repository: f.repository as never, workspaceId, taskId: 'task-1', contentVersionId: 'version-1',
      rating: 'liked', reason, actorId: 'merchant-1', idempotencyKey: 'feedback-stable-key-001', production: true,
      eventPayload: feedback => ({ task_id: feedback.taskId }), persistFallback: async () => undefined,
    })
    const first = await submit()
    const replay = await submit()
    expect(first.replayed).toBe(false)
    expect(replay).toMatchObject({ replayed: true, feedback: { id: first.feedback.id } })
    expect(f.repository.submit).toHaveBeenCalledTimes(2)
    await expect(submit('different reason')).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' })
    const otherWorkspace = await submit('clear product facts', 'ws-b')
    expect(otherWorkspace.replayed).toBe(false)
    expect(otherWorkspace.feedback.id).not.toBe(first.feedback.id)
  })

  it('rejects missing or malformed keys before submission', async () => {
    const f = fixture()
    await expect(submitTaskFeedbackIdempotently({ service: f.service as never, repository: f.repository as never, workspaceId: 'ws-a', taskId: 'task-1', rating: 'liked', actorId: 'merchant-1', idempotencyKey: '', production: true, eventPayload: () => ({}), persistFallback: async () => undefined })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_INVALID' })
    expect(f.repository.submit).not.toHaveBeenCalled()
  })

  it('deduplicates concurrent fallback persistence and keeps workspace feedback IDs unique', async () => {
    const f = fixture()
    let releasePersistence!: () => void
    const persistFallback = vi.fn(() => new Promise<void>(resolve => { releasePersistence = resolve }))
    const submit = (workspaceId: string) => submitTaskFeedbackIdempotently({
      service: f.service as never, workspaceId, taskId: 'task-1', rating: 'liked', actorId: 'merchant-1',
      idempotencyKey: 'feedback-stable-key-001', production: false, eventPayload: () => ({}), persistFallback,
    })
    const first = submit('ws-a')
    const concurrentReplay = submit('ws-a')
    await Promise.resolve()
    expect(persistFallback).toHaveBeenCalledTimes(1)
    releasePersistence()
    const [firstResult, replayResult] = await Promise.all([first, concurrentReplay])
    expect(firstResult.replayed).toBe(false)
    expect(replayResult).toMatchObject({ replayed: true, feedback: { id: firstResult.feedback.id } })

    const otherWorkspace = await submitTaskFeedbackIdempotently({
      service: f.service as never, workspaceId: 'ws-b', taskId: 'task-1', rating: 'liked', actorId: 'merchant-1',
      idempotencyKey: 'feedback-stable-key-001', production: false, eventPayload: () => ({}), persistFallback: async () => undefined,
    })
    expect(otherWorkspace.feedback.id).not.toBe(firstResult.feedback.id)
  })
})
