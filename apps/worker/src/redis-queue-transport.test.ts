import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type RedisClientType } from 'redis'
import { connectRedisQueue, RedisQueueDepthExceededError } from './redis-transport.js'
import { RedisQueueAdapter, type DurableOutboxEvent } from '../../../packages/workers/src/durable.js'

const redisUrl = process.env.REDIS_URL
const encoded = (id: string) => JSON.stringify({ id, value: JSON.stringify({ id }) })

describe.skipIf(!redisUrl)('redis durable queue transport', () => {
  let connection: Awaited<ReturnType<typeof connectRedisQueue>> | undefined
  let roomyConnection: Awaited<ReturnType<typeof connectRedisQueue>> | undefined
  let inspector: RedisClientType | undefined
  const prefix = `worker_queue_test_${randomUUID()}`
  const queues = ['recovery', 'retry', 'depth', 'membership', 'pressure', 'delayed_ack', 'indexed']
  const key = (name: string) => `${prefix}:${name}`
  const transport = () => connection!.transport

  beforeAll(async () => {
    connection = await connectRedisQueue(redisUrl!, { maxDepth: 4 })
    roomyConnection = await connectRedisQueue(redisUrl!, { maxDepth: 1_000 })
    inspector = createClient({ url: redisUrl! })
    inspector.on('error', () => undefined)
    await inspector.connect()
  }, 30_000)

  afterAll(async () => {
    if (inspector) {
      const keys = queues.flatMap(name => [key(name), `${key(name)}:processing`, `${key(name)}:delayed`, `${key(name)}:ids`])
      await inspector.del(keys).catch(() => undefined)
      await inspector.quit()
    }
    await roomyConnection?.close()
    await connection?.close()
  })

  it('offers only claims whose liveness proof stopped being refreshed, and never moves them', async () => {
    const queue = key('recovery')
    const claimedAt = Date.now()
    const claimLiveness = async (score: number) => await inspector!.zAdd(`${queue}:processing`, { score, value: encoded('evt_live') })

    await transport().push!(queue, encoded('evt_live'))
    expect(await transport().pop!(queue, 0)).toBe(encoded('evt_live'))

    // A worker that stopped proving liveness: the claim timestamp is the last
    // evidence, and the scan offers it to a caller that must still confirm the
    // durable lease before anything is discarded.
    await claimLiveness(claimedAt)
    expect(await transport().listStaleClaims!(queue, claimedAt)).toEqual([encoded('evt_live')])
    expect(await inspector!.zCard(`${queue}:processing`)).toBe(1)

    // A live worker heartbeats the claim. Recovery at the very moment the
    // original claim timestamp went stale must leave in-flight work alone.
    await transport().refresh!(queue, encoded('evt_live'))
    expect(await transport().listStaleClaims!(queue, claimedAt)).toEqual([])
    expect(await inspector!.zCard(`${queue}:processing`)).toBe(1)

    // Discarding is idempotent and releases the membership index exactly once.
    expect(await transport().discardClaim!(queue, encoded('evt_live'))).toBe(1)
    expect(await transport().discardClaim!(queue, encoded('evt_live'))).toBe(0)
    expect(await inspector!.zCard(`${queue}:processing`)).toBe(0)
    expect(await transport().contains!(queue, 'evt_live')).toBe(false)
  })

  it('answers membership from an index instead of parsing every queued entry', async () => {
    const commands: string[] = []
    const counted = await connectRedisQueue(redisUrl!, {
      maxDepth: 1_000,
      clientFactory: url => new Proxy(createClient({ url }) as RedisClientType, {
        get(target, property) {
          const value = Reflect.get(target, property) as unknown
          if (typeof property !== 'string' || typeof value !== 'function') return value
          return (...args: unknown[]) => {
            commands.push(property)
            return (value as (...rest: unknown[]) => unknown).apply(target, args)
          }
        },
      }) as RedisClientType,
    })
    try {
      const queue = key('indexed')
      for (let index = 0; index < 25; index += 1) await counted.transport.push!(queue, encoded(`evt_indexed_${index}`))
      commands.length = 0
      expect(await counted.transport.contains!(queue, 'evt_indexed_7')).toBe(true)
      expect(await counted.transport.contains!(queue, 'evt_absent')).toBe(false)
      expect(commands).toEqual(['hExists', 'hExists'])
    } finally {
      await counted.close()
    }
  })

  it('schedules a delayed retry without blocking and without making it claimable early', async () => {
    const queue = key('retry')
    await transport().push!(queue, encoded('evt_retry'))
    expect(await transport().pop!(queue, 0)).toBe(encoded('evt_retry'))

    const startedAt = Date.now()
    await transport().pushDelayed!(queue, encoded('evt_retry'), startedAt + 400)
    expect(Date.now() - startedAt).toBeLessThan(200)
    expect(await transport().pop!(queue, 0)).toBeUndefined()
    expect(await inspector!.lLen(queue)).toBe(0)
    expect(await inspector!.zCard(`${queue}:delayed`)).toBe(1)

    await new Promise(resolve => setTimeout(resolve, 450))
    expect(await transport().pop!(queue, 0)).toBe(encoded('evt_retry'))
  })

  it('bounds queue depth and reports capacity so workers can stop claiming', async () => {
    const queue = key('depth')
    for (let index = 0; index < 4; index += 1) await transport().push!(queue, encoded(`evt_depth_${index}`))
    expect(await transport().hasCapacity!(queue)).toBe(false)
    await expect(transport().push!(queue, encoded('evt_overflow'))).rejects.toBeInstanceOf(RedisQueueDepthExceededError)

    expect(await transport().pop!(queue, 0)).toBeDefined()
    expect(await transport().hasCapacity!(queue)).toBe(true)
  })

  it('reports membership for ready, in-flight and delayed entries', async () => {
    const adapter = new RedisQueueAdapter<DurableOutboxEvent>(roomyConnection!.transport, key('membership'))
    const event = (id: string) => ({ id, workspaceId: 'ws_1', aggregateId: id, eventType: 'task.created', sequence: 1, payload: {}, createdAt: new Date(1_000).toISOString() }) as DurableOutboxEvent
    for (let index = 0; index < 50; index += 1) await adapter.enqueue({ id: `evt_queued_${index}`, value: event(`evt_queued_${index}`) })
    await adapter.enqueue({ id: 'evt_in_flight', value: event('evt_in_flight') })
    expect(await adapter.contains('evt_queued_37')).toBe(true)
    expect(await adapter.contains('evt_absent')).toBe(false)

    // A claimed message is still contained while its lease is outstanding.
    const first = await adapter.dequeue()
    expect(first?.id).toBe('evt_queued_0')
    expect(await adapter.contains('evt_queued_0')).toBe(true)
    await adapter.ack(first!)
    expect(await adapter.contains('evt_queued_0')).toBe(false)

    // A scheduled retry stays contained until it is claimed and acknowledged.
    const second = await adapter.dequeue()
    expect(second?.id).toBe('evt_queued_1')
    await adapter.nack(second!, 30)
    expect(await adapter.contains('evt_queued_1')).toBe(true)
    expect(await inspector!.zCard(`${key('membership')}:delayed`)).toBe(1)
    expect(await inspector!.lLen(key('membership'))).toBe(49)

    // The membership index is released once the last copy is gone; a leaked
    // counter would hide the event from every later restore and stop restore()
    // from ever re-hydrating it.
    const delayed = new RedisQueueAdapter<DurableOutboxEvent>(roomyConnection!.transport, key('delayed_ack'))
    await delayed.enqueue({ id: 'evt_delayed_ack', value: event('evt_delayed_ack') })
    await delayed.nack((await delayed.dequeue())!, 30)
    expect(await delayed.contains('evt_delayed_ack')).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 60))
    const retried = await delayed.dequeue()
    expect(retried?.id).toBe('evt_delayed_ack')
    await delayed.ack(retried!)
    expect(await delayed.contains('evt_delayed_ack')).toBe(false)
    expect(Number(await inspector!.hExists(`${key('delayed_ack')}:ids`, 'evt_delayed_ack'))).toBe(0)
  })

  it('stops admitting work once the queue is full instead of growing without bound', async () => {
    const adapter = new RedisQueueAdapter<DurableOutboxEvent>(transport(), key('pressure'))
    const event = { id: 'evt_pressure', workspaceId: 'ws_1', aggregateId: 'a', eventType: 'task.created', sequence: 1, payload: {}, createdAt: new Date(1_000).toISOString() } as DurableOutboxEvent
    expect(await adapter.hasCapacity()).toBe(true)
    for (let index = 0; index < 4; index += 1) await adapter.enqueue({ id: `evt_pressure_${index}`, value: event })

    expect(await adapter.hasCapacity()).toBe(false)
    await expect(adapter.enqueue({ id: 'evt_pressure_overflow', value: event })).rejects.toMatchObject({ code: 'WORKER_QUEUE_DEPTH_EXCEEDED' })
  })
})
