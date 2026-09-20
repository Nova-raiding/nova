import type { HttpRequestDescriptor } from '../types.js'

/**
 * Methods whose requests must not carry a body. `fetch` rejects them before any
 * network call — `new Request(url, { method: 'GET', body })` throws
 * `TypeError: Request with GET/HEAD method cannot have body` — so a signed form
 * body on one of these makes the request undispatchable rather than failing at
 * the provider.
 */
export function isBodylessMethod(method: string): boolean {
  const upper = method.toUpperCase()
  return upper === 'GET' || upper === 'HEAD'
}

/**
 * Places the signed parameter set on the request as its urlencoded form body.
 *
 * HARD CONSTRAINT — platform credentials must never appear in the request URL.
 * The parameter set this receives is not business data: every router signer adds
 * the OAuth access token to it (`params.access_token` for JD/Pinduoduo,
 * `params.session` for Alibaba TOP) together with `app_key`/`client_id` and the
 * request signature. A credential in the URL is recorded by every hop that logs
 * a request line — the platform's own access log, any forward proxy on the
 * host, and any future request-URL logging or APM span in
 * `HttpPlatformConnector` — and unlike an `authorization` header it cannot be
 * redacted by those systems, because it is the request identity itself. The
 * write path (`create_product`/`update_product`/`query_write`/`upload_media`)
 * has always kept these values in the body; the read path used to be the one
 * exception, because `syncProducts` dispatched it as `GET` and a signed body on
 * a GET is rejected by `fetch` before DNS.
 *
 * The fix is the transport, not the URL: every router gateway here selects its
 * API from the signed `method`/`type` form parameter on the same
 * `api.baseUrl` the write path already POSTs to, so a read is dispatched as
 * `POST` with the identical signed parameter set. The read path therefore never
 * needs a bodyless method, and this function refuses one instead of falling back
 * to the query — a fallback that would silently publish the credential.
 *
 * The caller assembles `params` with the API selector assigned *last*, so
 * writing the set onto the body cannot retarget the call: any `method=`/`type=`
 * that arrived in the original query is replaced by the configured value. The
 * query string is cleared rather than merged: a request URL is only ever a
 * relative API path plus the caller's own paging parameters, and those are
 * already part of `params`.
 *
 * Shared by the router signers so the request shape cannot drift between them.
 */
export function applySignedRequest(request: HttpRequestDescriptor, url: URL, params: Record<string, string>): void {
  url.search = ''
  if (isBodylessMethod(request.method)) {
    // Terminal local defect, classified like a missing API selector: nothing is
    // dispatched, and the message must never suggest the query as a transport.
    throw Object.assign(
      new Error(`${request.method.toUpperCase()} ${request.operation} cannot carry the signed parameter set: credentials must stay out of the URL, so the read path is dispatched as POST with a form body`),
      { code: 'NOT_CONFIGURED', retryable: false, unknown: false },
    )
  }
  request.url = url.toString()
  request.body = new URLSearchParams(params).toString()
  request.headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8'
}
