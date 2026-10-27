import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MAX_UPLOAD_BYTES, UploadSessionManager, MemoryUploadSessionTransport } from './upload-session.js'

describe('upload sessions', () => {
  const sha256 = createHash('sha256').update('abc').digest('hex')

  it('uses the object-storage filename and MIME contracts before opening a session', async () => {
    const manager = new UploadSessionManager(new MemoryUploadSessionTransport())
    for (const fileName of ['.', '..']) {
      await expect(manager.create({ workspaceId: 'w', fileName, contentType: 'text/plain', sizeBytes: 3, sha256 }))
        .rejects.toThrow('UPLOAD_FILE_NAME_INVALID')
    }
    await expect(manager.create({ workspaceId: 'w', fileName: 'Logo.PNG', contentType: 'text/plain\r\nX-Injected: yes', sizeBytes: 3, sha256 }))
      .rejects.toThrow('UPLOAD_CONTENT_TYPE_INVALID')

    const session = await manager.create({ workspaceId: 'w', fileName: ' Logo.PNG ', contentType: 'IMAGE/PNG', sizeBytes: 3, sha256 })
    expect(session.fileName).toBe('logo.png')
    expect(session.contentType).toBe('image/png')
  })

  it('validates size and digest without base64', async () => {
    const body = Buffer.from('abc')
    const manager = new UploadSessionManager(new MemoryUploadSessionTransport())
    const session = await manager.create({ workspaceId: 'w', fileName: 'x', contentType: 'text/plain', sizeBytes: 3, sha256: createHash('sha256').update(body).digest('hex') })
    await manager.putPart(session.id, 1, body)
    expect((await manager.complete(session.id)).objectKey).toContain('quarantine/w/uploads/')
    await expect(manager.create({ workspaceId: 'w', fileName: 'x', contentType: 'x', sizeBytes: MAX_UPLOAD_BYTES + 1, sha256: 'a'.repeat(64) })).rejects.toThrow('UPLOAD_SIZE_LIMIT_EXCEEDED')
  })
})
