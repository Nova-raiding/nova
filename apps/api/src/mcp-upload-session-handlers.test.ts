import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DomainError } from '../../../packages/application/src/service.js'
import { MemoryUploadSessionTransport, UploadSessionManager } from '../../../packages/storage/src/upload-session.js'
import { handleMcpUploadSessionMethod } from './mcp-upload-session-handlers.js'

const required = (params: Record<string, unknown>, key: string) => {
  const value = params[key]
  if (typeof value !== 'string') throw new DomainError('INVALID_REQUEST', `missing ${key}`, 400)
  return value
}

describe('MCP upload sessions without a transport', () => {
  const dependencies = { uploadSessions: new UploadSessionManager(), required }

  it('returns the transport configuration error before checking a missing session', async () => {
    await expect(handleMcpUploadSessionMethod('upload.session.create', {
      file_name: 'source.txt', content_type: 'text/plain', size_bytes: '3', sha256: 'a'.repeat(64),
    }, 'ws_test', dependencies)).rejects.toMatchObject({ code: 'UPLOAD_TRANSPORT_NOT_CONFIGURED' })
    await expect(handleMcpUploadSessionMethod('upload.session.part', {
      session_id: 'missing', part_number: '1', content_base64: 'YWJj',
    }, 'ws_test', dependencies)).rejects.toMatchObject({ code: 'UPLOAD_TRANSPORT_NOT_CONFIGURED' })
    await expect(handleMcpUploadSessionMethod('upload.session.complete', {
      session_id: 'missing',
    }, 'ws_test', dependencies)).rejects.toMatchObject({ code: 'UPLOAD_TRANSPORT_NOT_CONFIGURED' })
  })

  it('returns 503 for part and complete when transport is absent, even if the session ID is unknown', async () => {
    await expect(handleMcpUploadSessionMethod('upload.session.part', {
      session_id: 'unknown', part_number: '1', content_base64: 'YWJj',
    }, 'ws_test', dependencies)).rejects.toMatchObject({ code: 'UPLOAD_TRANSPORT_NOT_CONFIGURED', status: 503 })
    await expect(handleMcpUploadSessionMethod('upload.session.complete', {
      session_id: 'unknown',
    }, 'ws_test', dependencies)).rejects.toMatchObject({ code: 'UPLOAD_TRANSPORT_NOT_CONFIGURED', status: 503 })
  })
})

describe('MCP upload session part write recovery', () => {
  it('fails closed when remote session creation rejects and does not retain the session or idempotency key', async () => {
    let createCalls = 0
    let attemptedId = ''
    const manager = new UploadSessionManager({
      create: async session => {
        createCalls += 1
        attemptedId = session.id
        throw new Error('remote create failed')
      },
      putPart: () => {},
      complete: () => ({ sizeBytes: 3, sha256: createHash('sha256').update('abc').digest('hex') }),
    })
    const params = {
      file_name: 'x.txt', content_type: 'text/plain', size_bytes: '3', sha256: createHash('sha256').update('abc').digest('hex'),
      idempotency_key: 'remote-create-failure',
    }

    await expect(handleMcpUploadSessionMethod('upload.session.create', params, 'ws_test', { uploadSessions: manager, required })).rejects.toMatchObject({
      code: 'UPLOAD_SESSION_CREATE_FAILED', status: 503, details: { retryable: false },
    })
    expect(attemptedId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(manager.belongsToWorkspace(attemptedId, 'ws_test')).toBe(false)

    await expect(handleMcpUploadSessionMethod('upload.session.create', params, 'ws_test', { uploadSessions: manager, required })).rejects.toMatchObject({
      code: 'UPLOAD_SESSION_CREATE_FAILED', status: 503,
    })
    expect(createCalls).toBe(2)
  })

  it('rejects malformed base64 before storage and accepts standard unpadded base64', async () => {
    let writes = 0
    const manager = new UploadSessionManager({
      putPart: () => { writes += 1 },
      complete: () => ({ sizeBytes: 2, sha256: createHash('sha256').update('ab').digest('hex') }),
    })
    const session = await manager.create({ workspaceId: 'ws_test', fileName: 'x.txt', contentType: 'text/plain', sizeBytes: 2, sha256: createHash('sha256').update('ab').digest('hex') })

    await expect(handleMcpUploadSessionMethod('upload.session.part', {
      session_id: session.id, part_number: '1', content_base64: 'Y!WI',
    }, 'ws_test', { uploadSessions: manager, required })).rejects.toMatchObject({
      code: 'INVALID_REQUEST', status: 400,
    })
    expect(writes).toBe(0)
    expect(session.parts.has(1)).toBe(false)

    await expect(handleMcpUploadSessionMethod('upload.session.part', {
      session_id: session.id, part_number: '1', content_base64: 'YWI',
    }, 'ws_test', { uploadSessions: manager, required })).resolves.toEqual({ part: 1, sizeBytes: 2 })
    expect(writes).toBe(1)
  })

  it('does not record metadata for an unknown write and safely retries the same part number', async () => {
    let writes = 0
    const digest = createHash('sha256').update('abc').digest('hex')
    const remote = new MemoryUploadSessionTransport()
    const manager = new UploadSessionManager({
      putPart: async (sessionId, part, bytes) => {
        writes += 1
        remote.putPart(sessionId, part, bytes)
        // The provider committed the part, but the caller lost its receipt.
        if (writes === 1) throw new Error('object store connection reset after write')
      },
      complete: session => remote.complete(session),
    })
    const session = await manager.create({ workspaceId: 'ws_test', fileName: 'x.txt', contentType: 'text/plain', sizeBytes: 3, sha256: digest })
    const params = { session_id: session.id, part_number: '1', content_base64: 'YWJj' }

    await expect(handleMcpUploadSessionMethod('upload.session.part', params, 'ws_test', { uploadSessions: manager, required }))
      .rejects.toMatchObject({ code: 'UPLOAD_PART_WRITE_FAILED', status: 503, details: { retryable: true } })
    expect(session.parts.has(1)).toBe(false)
    expect(await handleMcpUploadSessionMethod('upload.session.part', params, 'ws_test', { uploadSessions: manager, required }))
      .toEqual({ part: 1, sizeBytes: 3 })
    expect(session.parts.get(1)).toBe(3)
    expect((await manager.complete(session.id)).state).toBe('completed')
    expect(writes).toBe(2)
  })

  it('preserves request validation errors instead of labeling them retryable storage failures', async () => {
    const manager = new UploadSessionManager({ putPart: () => {}, complete: () => ({ sizeBytes: 0, sha256: 'a'.repeat(64) }) })
    const session = await manager.create({ workspaceId: 'ws_test', fileName: 'x.txt', contentType: 'text/plain', sizeBytes: 3, sha256: 'a'.repeat(64) })

    await expect(handleMcpUploadSessionMethod('upload.session.part', {
      session_id: session.id, part_number: '1',
    }, 'ws_test', { uploadSessions: manager, required })).rejects.toMatchObject({
      code: 'INVALID_REQUEST', status: 400,
    })
  })

  it('maps create and completion business validation errors without claiming transport is unconfigured', async () => {
    const manager = new UploadSessionManager({ putPart: () => {}, complete: () => ({ sizeBytes: 2, sha256: 'a'.repeat(64) }) })

    await expect(handleMcpUploadSessionMethod('upload.session.create', {
      file_name: 'x.txt', content_type: 'text/plain', size_bytes: '0', sha256: 'a'.repeat(64),
    }, 'ws_test', { uploadSessions: manager, required })).rejects.toMatchObject({
      code: 'UPLOAD_SIZE_LIMIT_EXCEEDED', status: 422,
    })

    const session = await manager.create({ workspaceId: 'ws_test', fileName: 'x.txt', contentType: 'text/plain', sizeBytes: 3, sha256: 'a'.repeat(64) })
    await expect(handleMcpUploadSessionMethod('upload.session.complete', {
      session_id: session.id,
    }, 'ws_test', { uploadSessions: manager, required })).rejects.toMatchObject({
      code: 'UPLOAD_SIZE_MISMATCH', status: 422,
    })
  })

  it('fails closed on an unknown completion outcome without declaring transport missing or retryable', async () => {
    const manager = new UploadSessionManager({
      putPart: () => {},
      complete: () => { throw new Error('connection reset after completion') },
    })
    const session = await manager.create({ workspaceId: 'ws_test', fileName: 'x.txt', contentType: 'text/plain', sizeBytes: 3, sha256: 'a'.repeat(64) })

    await expect(handleMcpUploadSessionMethod('upload.session.complete', {
      session_id: session.id,
    }, 'ws_test', { uploadSessions: manager, required })).rejects.toMatchObject({
      code: 'UPLOAD_COMPLETE_OUTCOME_UNKNOWN', status: 503, details: { retryable: false },
    })
  })
})
