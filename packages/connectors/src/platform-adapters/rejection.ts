import type { PlatformRejection, PlatformRejectionField } from '../types.js'

type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined
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
  const root = record(payload)
  const rejection = record(root?.platform_rejection) ?? record(root?.rejection) ?? record(root?.error_response) ?? record(root?.error) ?? root
  const rawCode = text(rejection?.raw_code, rejection?.code, rejection?.error_code, rejection?.sub_code)
  if (!rawCode) return undefined
  const message = text(rejection?.message, rejection?.msg, rejection?.reason, rejection?.sub_msg, rejection?.error_message)
  const candidates = rejection?.fields ?? rejection?.field_errors ?? rejection?.errors
  const fields = (Array.isArray(candidates) ? candidates : []).map(fieldError).filter((item): item is PlatformRejectionField => Boolean(item))
  return { rawCode, ...(message ? { message } : {}), fields }
}
