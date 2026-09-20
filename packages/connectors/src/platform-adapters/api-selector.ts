import type { ConnectorOperation, HttpRequestDescriptor, PlatformApiMethods, PlatformApiSelector } from '../types.js'

/**
 * Selector each signed operation needs. OAuth operations are deliberately
 * absent: `HttpPlatformConnector.request` never signs them (they address the
 * token endpoints), so a signer that is asked to sign one is being misused and
 * refuses instead of signing an arbitrary API.
 */
export const API_SELECTOR_BY_OPERATION: Readonly<Partial<Record<ConnectorOperation, PlatformApiSelector>>> = {
  sync_products: 'sync',
  create_product: 'create',
  update_product: 'update',
  query_write: 'query',
  upload_media: 'media',
}

/**
 * Selector keys a router-gateway signer consumes, in the order the
 * configuration reads them. Exported so the environment key family
 * (`{SYNC,CREATE,UPDATE,QUERY,MEDIA}_METHOD`), the connector configuration and
 * the signers cannot drift into three different lists.
 */
export const PLATFORM_API_SELECTORS: readonly PlatformApiSelector[] = ['sync', 'create', 'update', 'query', 'media']

/**
 * Selectors a signer declares (`RequestSigner.requiredApiSelectors`) that the
 * connector configuration does not provide. Readiness uses this to refuse a
 * router platform at admission time; the request-time path stays exactly as
 * strict, so the same configuration can never become signable by retrying.
 */
export function missingApiSelectors(
  methods: PlatformApiMethods | undefined,
  required: readonly PlatformApiSelector[] | undefined,
): PlatformApiSelector[] {
  if (!required?.length) return []
  return required.filter(selector => {
    const configured = methods?.[selector]
    return typeof configured !== 'string' || !configured.trim()
  })
}

export interface ApiSelectorResolution {
  /** Operator-facing signer name, for example `Alibaba TOP`. */
  signer: string
  /** Request parameter the selector is written into: `method` or `type`. */
  parameter: string
}

/**
 * Resolves the platform API for one request from the connector's explicit
 * configuration.
 *
 * The selector is deliberately *not* read from the request URL. The URL is
 * assembled from `api.syncPath`/`createPath`/`updatePath`/`queryPath`, which
 * readiness requires to be relative paths without a query string
 * (`validRelativePath` rejects `?`), so a `?method=`/`?type=` in the URL can
 * never be configured — scraping it silently signed every operation as
 * whichever API the fallback named. A gateway whose API is not configured for
 * the operation in flight is a configuration defect: it is reported as a
 * non-retryable `NOT_CONFIGURED` failure naming the exact missing selector, so
 * the outbox does not replay a permanently unsignable request.
 */
export function resolveApiSelector(request: HttpRequestDescriptor, methods: PlatformApiMethods | undefined, resolution: ApiSelectorResolution): string {
  const selector = API_SELECTOR_BY_OPERATION[request.operation]
  if (!selector) throw apiSelectorError(`${resolution.signer} must not sign the ${request.operation} operation; OAuth and token requests are never signed by a platform signer`)
  const configured = methods?.[selector]
  const value = typeof configured === 'string' ? configured.trim() : ''
  if (!value) {
    throw apiSelectorError(`${resolution.signer} has no API ${resolution.parameter} configured for the ${request.operation} operation: set api.methods.${selector}. The connector will not fall back to another operation's API.`)
  }
  return value
}

/** The connector classifies a thrown `NOT_CONFIGURED` signer failure as a
 * terminal local defect and keeps this message (`normalizeSignerError`). */
function apiSelectorError(message: string): Error {
  return Object.assign(new Error(message), { code: 'NOT_CONFIGURED', retryable: false, unknown: false })
}
