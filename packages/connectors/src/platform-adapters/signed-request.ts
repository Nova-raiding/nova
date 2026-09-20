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
 * Places the signed parameter set on the request in the shape the HTTP method
 * requires.
 *
 * `GET`/`HEAD` carry every parameter in the URL query and must leave the
 * request bodyless: the platform verifies the same canonical signature either
 * way, and `fetch` refuses a body on these methods. Every other method keeps
 * the urlencoded form body the router gateways expect.
 *
 * The caller assembles `params` with the API selector assigned *last*, so
 * writing the set back over the query cannot retarget the call: any
 * `method=`/`type=` that arrived in the original query is replaced by the
 * configured value, exactly as it is on the form-body path.
 *
 * Shared by the router signers so the request shape cannot drift between them.
 */
export function applySignedRequest(request: HttpRequestDescriptor, url: URL, params: Record<string, string>): void {
  url.search = ''
  if (isBodylessMethod(request.method)) {
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    request.url = url.toString()
    // A signed GET carries nothing else, and a leftover body would be rejected
    // by `fetch` after signing had already succeeded.
    delete request.body
    return
  }
  request.url = url.toString()
  request.body = new URLSearchParams(params).toString()
  request.headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8'
}
