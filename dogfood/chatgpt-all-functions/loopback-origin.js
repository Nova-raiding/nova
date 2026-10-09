/** Fail closed before an E2E spec can authenticate or mutate any remote app. */
export function assertLoopbackHttpOrigin(raw) {
  let url
  try { url = new URL(raw) } catch { throw new Error('PLAYWRIGHT_LOOPBACK_ORIGIN_REQUIRED') }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash) {
    throw new Error('PLAYWRIGHT_LOOPBACK_ORIGIN_REQUIRED')
  }
  return url.origin
}
