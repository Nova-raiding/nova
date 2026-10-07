import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MemoryUploadSessionTransport, UploadSessionManager } from '../../../packages/storage/src/upload-session.js'
import { handleMcpUploadSessionMethod } from './mcp-upload-session-handlers.js'

const required = (params: Record<string, unknown>, key: string) => {
  const value = params[key]
  if (typeof value !== 'string') throw new Error(`missing ${key}`)
  return value
}

describe('MCP upload session successful isolated path', () => {
  it('creates a workspace-scoped session, accepts a part, and completes only after size and digest verification', async () => {
    const body = Buffer.from('isolated upload success')
    const manager = new UploadSessionManager(new MemoryUploadSessionTransport())
    const dependencies = { uploadSessions: manager, required }
    const workspaceId = 'ws_upload_success_fixture'

    const created = await handleMcpUploadSessionMethod('upload.session.create', {
      file_name: 'source.txt',
      content_type: 'text/plain',
      size_bytes: String(body.length),
      sha256: createHash('sha256').update(body).digest('hex'),
      idempotency_key: 'upload-success-1',
    }, workspaceId, dependencies) as { id: string; state: string; workspaceId: string }

    expect(created).toMatchObject({ state: 'open', workspaceId })

    const part = await handleMcpUploadSessionMethod('upload.session.part', {
      session_id: created.id,
      part_number: '1',
      content_base64: body.toString('base64'),
    }, workspaceId, dependencies)
    expect(part).toMatchObject({ part: 1, sizeBytes: body.length })

    const completed = await handleMcpUploadSessionMethod('upload.session.complete', {
      session_id: created.id,
    }, workspaceId, dependencies) as { state: string; objectKey?: string; sha256: string; sizeBytes: number }

    expect(completed).toMatchObject({
      state: 'completed',
      objectKey: `quarantine/${workspaceId}/uploads/${created.id}/source.txt`,
      sizeBytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
    })
  })
})
