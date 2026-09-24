import { afterAll, describe, expect, it } from 'vitest'
import { server } from './server.js'

/**
 * `/healthz` and `/v1/healthz` are no longer answered by the gateway: the nginx
 * pilot gateway proxies them to this process so a dead origin cannot report
 * healthy. That only works if the API answers the shape the probes actually
 * send — and the documented check is `curl -I`, i.e. a **HEAD** request.
 *
 * The API matched `GET` only, so every HEAD fell through to the 404 fallthrough.
 * A load balancer or uptime monitor probing with HEAD would have marked a
 * perfectly healthy origin down. Nothing covered this: the gateway config tests
 * slice the releasez block and never assert the healthz
 * locations, and no test issued a HEAD at all.
 *
 * The property asserted here is the one a probe depends on: for every
 * infrastructure probe, HEAD must return the same status as GET.
 */
const PROBE_PATHS = ['/healthz', '/readyz', '/livez', '/releasez'] as const

async function start() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

const base = await start()
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())) })

describe('infrastructure probes', () => {
  it.each(PROBE_PATHS)('%s answers HEAD with the same status as GET', async path => {
    const get = await fetch(`${base}${path}`, { method: 'GET' })
    const head = await fetch(`${base}${path}`, { method: 'HEAD' })
    // The 404 fallthrough is the regression this test exists for.
    expect(head.status, `HEAD ${path} fell through to the unknown-route handler`).not.toBe(404)
    expect(head.status, `HEAD ${path} disagrees with GET ${path}`).toBe(get.status)
  })

  it('does not confuse an unknown path with a probe', async () => {
    // The guard must be the method+path pair, not "any HEAD is fine".
    const response = await fetch(`${base}/definitely-not-a-route`, { method: 'HEAD' })
    expect(response.status).toBe(404)
  })
})
