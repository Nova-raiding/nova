/**
 * SCRATCH PROBE (deleted after the run): does the credential refresh lock's
 * `close()` survive a socket that is connected but never answers?
 *
 * A local TCP proxy in front of the running demo Redis is used so the "peer
 * blackholed" case (kube-proxy dropped the flow / frozen peer) can be produced
 * without touching anybody else's Redis: once blackholed, the client's socket
 * stays ESTABLISHED and every command written into it gets neither a reply nor
 * an error.
 */
import net from 'node:net'
import { connectRedisQueue, createRedisCredentialRefreshLock } from './apps/worker/src/redis-transport.js'

const UPSTREAM_HOST = '127.0.0.1'
const UPSTREAM_PORT = 56799 // merchant-demo-redis-1

const pairs: Array<{ client: net.Socket; upstream: net.Socket }> = []
const proxy = net.createServer(client => {
  const upstream = net.connect({ host: UPSTREAM_HOST, port: UPSTREAM_PORT })
  pairs.push({ client, upstream })
  client.pipe(upstream)
  upstream.pipe(client)
  client.on('error', () => undefined)
  upstream.on('error', () => undefined)
})
await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
const port = (proxy.address() as net.AddressInfo).port

const blackhole = () => {
  for (const { client, upstream } of pairs) {
    client.unpipe(upstream)
    upstream.unpipe(client)
    upstream.pause()
    client.pause()
  }
}

const settleWithin = async <T>(label: string, work: Promise<T>, ms: number): Promise<string> => {
  const startedAt = Date.now()
  const outcome = await Promise.race([
    work.then(value => `resolved:${JSON.stringify(value)}`, error => `rejected:${(error as { code?: string })?.code ?? String(error)}`),
    new Promise<string>(resolve => setTimeout(() => resolve('PARKED'), ms)),
  ])
  return `${label} -> ${outcome} (${Date.now() - startedAt}ms)`
}

const created = createRedisCredentialRefreshLock(`redis://127.0.0.1:${port}`)
if (!created) throw new Error('factory returned undefined')
// Baseline through the proxy: the connection is real and answering.
console.log(await settleWithin('baseline tryAcquire (live peer)', created.lock.tryAcquire('probe:close-hang:ignore', 2_000), 4_000))

blackhole()
console.log(await settleWithin('bounded op after blackhole (REDIS_OPERATION_TIMEOUT expected)', created.lock.tryAcquire('probe:close-hang:ignore', 2_000), 6_000))
// The production close: main.ts awaits exactly this in the shutdown finally.
console.log(await settleWithin('credential lock close() [production path]', created.close(), 8_000))

// Control: the bounded close every other worker connection uses.
const queue = await connectRedisQueue(`redis://127.0.0.1:${port}`)
console.log(await settleWithin('control baseline: queue push (live peer)', queue.transport.push('probe:close-hang:queue', '{"id":"probe"}'), 4_000))
blackhole()
console.log(await settleWithin('control bounded op after blackhole', queue.transport.contains('probe:close-hang:queue', 'probe'), 6_000))
console.log(await settleWithin('control: queue close() [closeRedisConnection]', queue.close(), 8_000))

const queue2 = await connectRedisQueue(`redis://127.0.0.1:${port}`)
await queue2.transport.contains('probe:close-hang:queue', 'probe')
blackhole()
await queue2.transport.contains('probe:close-hang:queue', 'probe').catch((error: Error) => console.log('queue2 op:', error.message))
await queue2.close().then(
  () => console.log('queue2 close: resolved'),
  (error: Error) => console.log('queue2 close REJECTED:', error.constructor.name, '|', error.message, '|', String(error.stack).split('\n').slice(1, 4).join(' < ')),
)

process.exit(0)
