import { describe, expect, it } from 'vitest'
import { UploadSessionManager } from '../../../packages/storage/src/upload-session.js'
import { handleMcpUploadSessionMethod } from './mcp-upload-session-handlers.js'

const required = (params: Record<string, unknown>, key: string) => {
  const value = params[key]
  if (typeof value !== 'string') throw new Error(`missing ${key}`)
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
