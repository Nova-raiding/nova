import { DomainError } from '../../../packages/application/src/service.js'
import type { UploadSessionManager } from '../../../packages/storage/src/upload-session.js'

type Dependencies = {
  uploadSessions: UploadSessionManager
  required: (params: Record<string, unknown>, key: string) => string
}

export const MCP_UPLOAD_SESSION_METHODS = new Set(['upload.session.create', 'upload.session.part', 'upload.session.complete'])

const validationStatuses: Record<string, number> = {
  UPLOAD_DIGEST_INVALID: 422,
  UPLOAD_DIGEST_MISMATCH: 422,
  UPLOAD_PART_INVALID: 422,
  UPLOAD_SESSION_EXPIRED: 410,
  UPLOAD_SESSION_NOT_FOUND: 404,
  UPLOAD_SESSION_NOT_OPEN: 409,
  UPLOAD_SIZE_LIMIT_EXCEEDED: 422,
  UPLOAD_SIZE_MISMATCH: 422,
}

function requireUploadTransport(uploadSessions: UploadSessionManager): void {
  if (!uploadSessions.configured) {
    throw new DomainError('UPLOAD_TRANSPORT_NOT_CONFIGURED', '上传服务未配置真实对象存储 transport', 503)
  }
}

function mapKnownUploadError(error: unknown): DomainError | undefined {
  if (error instanceof DomainError) return error
  const code = error instanceof Error ? error.message : ''
  const status = validationStatuses[code]
  return status ? new DomainError(code, code, status) : undefined
}

function decodeUploadPart(value: string): Buffer {
  // Buffer.from(..., 'base64') ignores invalid characters. Reject malformed
  // input at the MCP boundary so clients get a request error before a partial
  // or corrupted part can be written to object storage.
  const compact = value.trim()
  const validBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/u.test(compact)
  if (!compact || !validBase64) {
    throw new DomainError('INVALID_REQUEST', 'content_base64 必须是有效的 Base64 字符串', 400)
  }
  return Buffer.from(compact, 'base64')
}

export async function handleMcpUploadSessionMethod(method: string, params: Record<string, unknown>, workspaceId: string, dependencies: Dependencies): Promise<unknown> {
  const { uploadSessions, required } = dependencies
  if (method === 'upload.session.create') {
    // A session without a configured transport must fail closed; never report a fake upload.
    const size = Number(required(params, 'size_bytes'))
    requireUploadTransport(uploadSessions)
    const input = {
      workspaceId,
      fileName: required(params, 'file_name'),
      contentType: required(params, 'content_type'),
      sizeBytes: size,
      sha256: required(params, 'sha256'),
      ...(typeof params.idempotency_key === 'string' ? { idempotencyKey: params.idempotency_key } : {}),
    }
    try {
      return await uploadSessions.create(input)
    } catch (error) {
      const known = mapKnownUploadError(error)
      if (known) throw known
      throw new DomainError('UPLOAD_SESSION_CREATE_FAILED', '上传会话未能在存储服务中确认创建', 503, { retryable: false })
    }
  }

  if (method === 'upload.session.part') {
    const sessionId = required(params, 'session_id')
    requireUploadTransport(uploadSessions)
    if (!uploadSessions.belongsToWorkspace(sessionId, workspaceId)) throw new DomainError('UPLOAD_SESSION_NOT_FOUND', '上传会话不存在', 404)
    const bytes = decodeUploadPart(required(params, 'content_base64'))
    const part = Number(required(params, 'part_number'))
    try {
      return await uploadSessions.putPart(sessionId, part, bytes)
    } catch (error) {
      const known = mapKnownUploadError(error)
      if (known) throw known
      throw new DomainError('UPLOAD_PART_WRITE_FAILED', '对象存储未确认该分片写入；请使用相同分片号重试', 503, { retryable: true, partNumber: part })
    }
  }

  if (method === 'upload.session.complete') {
    const sessionId = required(params, 'session_id')
    requireUploadTransport(uploadSessions)
    if (!uploadSessions.belongsToWorkspace(sessionId, workspaceId)) throw new DomainError('UPLOAD_SESSION_NOT_FOUND', '上传会话不存在', 404)
    try {
      return await uploadSessions.complete(sessionId)
    } catch (error) {
      const known = mapKnownUploadError(error)
      if (known) throw known
      // Completion may have succeeded remotely even if its response was lost; automatic retries are unsafe.
      throw new DomainError('UPLOAD_COMPLETE_OUTCOME_UNKNOWN', '存储服务未确认上传完成结果', 503, { retryable: false })
    }
  }

  throw new Error(`Unsupported upload session MCP method: ${method}`)
}
