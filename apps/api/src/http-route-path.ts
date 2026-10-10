import { DomainError } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'

/** Decode one captured URL path segment and classify malformed percent/UTF-8
 * escapes as a client input error instead of leaking a generic 500. */
export function decodeHttpPathSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'URL 路径参数编码无效', 400)
  }
}
