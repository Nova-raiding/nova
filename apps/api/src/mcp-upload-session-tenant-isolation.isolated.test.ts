import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MemoryUploadSessionTransport, UploadSessionManager } from '../../../packages/storage/src/upload-session.js'
import { handleMcpUploadSessionMethod } from './mcp-upload-session-handlers.js'

const required = (params: Record<string, unknown>, key: string) => {
  const value = params[key]
  if (typeof value !== 'string') throw new Error(`missing ${key}`)
  return value
}

describe('MCP upload session tenant isolation', () => {
  const createFixture = async () => {
    const body = Buffer.from('tenant-bound upload')
    const manager = new UploadSessionManager(new MemoryUploadSessionTransport())
    const dependencies = { uploadSessions: manager, required }
    const ownerWorkspace = 'ws_upload_owner'
    const session = await handleMcpUploadSessionMethod('upload.session.create', {
      file_name: 'tenant.txt',
      content_type: 'text/plain',
      size_bytes: String(body.length),
      sha256: createHash('sha256').update(body).digest('hex'),
    }, ownerWorkspace, dependencies) as { id: string }
    return { body, dependencies, ownerWorkspace, session }
  }

  it('rejects a part request from a different authenticated workspace', async () => {
    const { body, dependencies, session } = await createFixture()

    await expect(handleMcpUploadSessionMethod('upload.session.part', {
      session_id: session.id,
      part_number: '1',
      content_base64: body.toString('base64'),
    }, 'ws_upload_attacker', dependencies)).rejects.toMatchObject({ code: 'UPLOAD_SESSION_NOT_FOUND', status: 404 })
  })

  it('rejects completion from a different authenticated workspace', async () => {
    const { body, dependencies, ownerWorkspace, session } = await createFixture()
    await handleMcpUploadSessionMethod('upload.session.part', {
      session_id: session.id,
      part_number: '1',
      content_base64: body.toString('base64'),
    }, ownerWorkspace, dependencies)

    await expect(handleMcpUploadSessionMethod('upload.session.complete', {
      session_id: session.id,
    }, 'ws_upload_attacker', dependencies)).rejects.toMatchObject({ code: 'UPLOAD_SESSION_NOT_FOUND', status: 404 })
  })
})
