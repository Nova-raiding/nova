/** Return a stable, local-only correlation key for one Playwright API request. */
export function commercialRpcRequestSignature(request) {
  let body
  try { body = request.postDataJSON() } catch { body = request.postData() ?? '' }
  return JSON.stringify([
    request.method(),
    new URL(request.url()).pathname,
    body,
  ])
}
