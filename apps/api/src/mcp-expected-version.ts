import { DomainError } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'

/** Parse MCP's wire-level optional optimistic concurrency version. */
export function optionalMcpExpectedVersion(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  const parsed = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new DomainError(ERROR_CODES.INVALID_REQUEST, `${key} 必须是正安全整数`, 400)
  }
  return parsed
}
