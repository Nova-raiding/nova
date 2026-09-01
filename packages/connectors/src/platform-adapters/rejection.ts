import type { PlatformRejection, PlatformRejectionField } from '../types.js'

type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined
}

/** Providers commonly wrap the business result in `data`, `result`, or
 * `response`. Only follow known envelope keys; never recursively inspect an
 * arbitrary payload and accidentally promote merchant fields to evidence. */
export function platformEnvelope(value: unknown): JsonRecord | undefined {
  let current = record(value)
  for (let depth = 0; current && depth < 3; depth += 1) {
    const nested = [current.data, current.result, current.response, current.body]
      .map(record).find(Boolean)
    if (!nested) break
    current = nested
  }
  return current
}

/** Provider correlation evidence only. Local idempotency keys are deliberately
 * not accepted as a fallback. */
export function providerRequestId(value: unknown): string | undefined {
  let root = platformEnvelope(value)
  for (let depth = 0; root && depth < 3; depth += 1) {
    const candidate = root.request_id ?? root.requestId ?? root.provider_request_id
      ?? root.providerRequestId ?? root.task_id ?? root.taskId ?? root.transaction_id
    const result = text(candidate)
    if (result && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(result) && result.length <= 256) return result
    // Error responses use a second, documented envelope after `data`/`result`.
    // Follow only provider error keys; never recursively search arbitrary data.
    root = [root.error_response, root.platform_rejection, root.rejection, root.error]
      .map(record).find(Boolean)
  }
  return undefined
}

function text(...values: unknown[]): string | undefined {
  const value = values.find(item => typeof item === 'string' || typeof item === 'number')
  return value === undefined ? undefined : String(value).trim() || undefined
}

function fieldError(value: unknown): PlatformRejectionField | undefined {
  const item = record(value)
  if (!item) return undefined
  const path = text(item.path, item.field, item.property, item.param)
  const message = text(item.message, item.msg, item.reason, item.error_message)
  if (!path || !message) return undefined
  const rawCode = text(item.raw_code, item.code, item.error_code, item.sub_code)
  return { path, ...(rawCode ? { rawCode } : {}), message }
}

/** Keep only merchant-safe rejection evidence, never the complete response. */
export function mapPlatformRejection(payload: unknown): PlatformRejection | undefined {
  const root = platformEnvelope(payload)
  const rejection = record(root?.platform_rejection) ?? record(root?.rejection) ?? record(root?.error_response) ?? record(root?.error) ?? root
  const rawCode = text(rejection?.raw_code, rejection?.code, rejection?.error_code, rejection?.sub_code)
  if (!rawCode) return undefined
  const message = text(rejection?.message, rejection?.msg, rejection?.reason, rejection?.sub_msg, rejection?.error_message, rejection?.error_msg)
  const candidates = rejection?.fields ?? rejection?.field_errors ?? rejection?.errors
  const fields = (Array.isArray(candidates) ? candidates : []).map(fieldError).filter((item): item is PlatformRejectionField => Boolean(item))
  return { rawCode, ...(message ? { message } : {}), fields }
}
