import { DomainError } from '../../../packages/application/src/service.js'
import type { UploadSessionManager } from '../../../packages/storage/src/upload-session.js'

type Dependencies = {
  uploadSessions: UploadSessionManager
  required: (params: Record<string, unknown>, key: string) => string
}

export const MCP_UPLOAD_SESSION_METHODS = new Set(['upload.session.create', 'upload.session.part', 'upload.session.complete'])

export async function handleMcpUploadSessionMethod(method: string, params: Record<string, unknown>, workspaceId: string, dependencies: Dependencies): Promise<unknown> {
  const { uploadSessions, required } = dependencies
  if (method === 'upload.session.create') {
      // A session without a configured transport must fail closed; never report a fake upload.
      const size = Number(required(params, 'size_bytes'))
      if (!uploadSessions.configured) throw new DomainError('UPLOAD_TRANSPORT_NOT_CONFIGURED', '上传服务未配置真实对象存储 transport', 503)
      try {
        const session = uploadSessions.create({ workspaceId, fileName: required(params, 'file_name'), contentType: required(params, 'content_type'), sizeBytes: size, sha256: required(params, 'sha256'), ...(typeof params.idempotency_key === 'string' ? { idempotencyKey: params.idempotency_key } : {}) })
        return (session)
      } catch (error) { throw new DomainError('UPLOAD_TRANSPORT_NOT_CONFIGURED', error instanceof Error ? error.message : '上传服务未配置', 503) }
    }
  if (method === 'upload.session.part') {
      try { const bytes = Buffer.from(required(params, 'content_base64'), 'base64'); return (uploadSessions.putPart(required(params, 'session_id'), Number(required(params, 'part_number')), bytes)) }
      catch (error) { throw new DomainError('UPLOAD_TRANSPORT_NOT_CONFIGURED', error instanceof Error ? error.message : '上传服务未配置', 503) }
    }
  if (method === 'upload.session.complete') {
      try { return (await uploadSessions.complete(required(params, 'session_id'))) }
      catch (error) { throw new DomainError('UPLOAD_TRANSPORT_NOT_CONFIGURED', error instanceof Error ? error.message : '上传服务未配置', 503) }
    }
  throw new Error(`Unsupported upload session MCP method: ${method}`)
}
