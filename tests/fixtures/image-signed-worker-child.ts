/** Isolated test entry: real runWorker, only reserved .invalid provider transport maps to loopback. */
import { Pool } from 'pg'
import { readWorkerConfig, runWorker, workerDatabasePoolOptions } from '../../apps/worker/src/main.js'
const nativeFetch = globalThis.fetch
const endpoint = new URL(process.env.ISOLATED_PROVIDER_URL!)
if (endpoint.hostname !== '127.0.0.1' || !process.env.MERCHANT_ISOLATED_POSTGRES_RUN_ID) throw new Error('ISOLATED_ENDPOINT_REQUIRED')
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (url.hostname === 'provider.fixture.invalid') return nativeFetch(new URL(url.pathname + url.search, endpoint), init)
  if (url.hostname !== '127.0.0.1') throw new Error('TEST_EXTERNAL_NETWORK_FORBIDDEN')
  return nativeFetch(input, init)
}
const config = readWorkerConfig()
const pool = new Pool(workerDatabasePoolOptions(config))
try { await runWorker(config, pool) } finally { await pool.end() }
