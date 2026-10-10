import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MAX_UPLOAD_BYTES, UploadSessionManager, MemoryUploadSessionTransport } from './upload-session.js'

describe('upload sessions', () => {
  it('validates size and digest without base64', async () => {
    const body = Buffer.from('abc')
    const manager = new UploadSessionManager(new MemoryUploadSessionTransport())
    const session = manager.create({ workspaceId: 'w', fileName: 'x', contentType: 'text/plain', sizeBytes: 3, sha256: createHash('sha256').update(body).digest('hex') })
    await manager.putPart(session.id, 1, body)
    expect((await manager.complete(session.id)).objectKey).toContain('quarantine/w/uploads/')
    expect(() => manager.create({ workspaceId: 'w', fileName: 'x', contentType: 'x', sizeBytes: MAX_UPLOAD_BYTES + 1, sha256: 'a'.repeat(64) })).toThrow('UPLOAD_SIZE_LIMIT_EXCEEDED')
  })
})
