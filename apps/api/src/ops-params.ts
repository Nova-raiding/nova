import { DomainError } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'

type JsonObject = Record<string, unknown>
const OPS_DOMAIN_PARAMS_MAX_BYTES = 128 * 1024

export function assertBoundedOpsParams(params: JsonObject) {
  if (Buffer.byteLength(JSON.stringify(params), 'utf8') > OPS_DOMAIN_PARAMS_MAX_BYTES) throw new DomainError(ERROR_CODES.REQUEST_BODY_TOO_LARGE, '运营控制面参数超过 128 KiB 上限', 413)
}

export function aliasValue(input: JsonObject, camel: string, snake = camel): unknown {
  return input[camel] ?? input[snake]
}

export function optionalStringValue(input: JsonObject, camel: string, snake = camel): string | undefined {
  const value = aliasValue(input, camel, snake)
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function requiredStringValue(input: JsonObject, camel: string, snake = camel): string {
  const value = optionalStringValue(input, camel, snake)
  if (!value) throw new DomainError(ERROR_CODES.INVALID_REQUEST, `缺少必填字段: ${snake}`, 400)
  return value
}

export function optionalNumberValue(input: JsonObject, camel: string, snake = camel): number | undefined {
  const value = aliasValue(input, camel, snake)
  if (value === undefined || value === null || value === '') return undefined
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(parsed)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, `${snake} 必须是整数`, 400)
  return parsed
}

export function structuredValue(input: JsonObject, camel: string, snake = camel): unknown {
  const value = aliasValue(input, camel, snake)
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return value
  try { return JSON.parse(trimmed) }
  catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, `${snake} 必须是合法 JSON`, 400) }
}

export function stringArrayValue(input: JsonObject, camel: string, snake = camel): string[] | undefined {
  const value = structuredValue(input, camel, snake)
  if (value === undefined || value === null || value === '') return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new DomainError(ERROR_CODES.INVALID_REQUEST, `${snake} 必须是字符串数组`, 400)
  return value
}
