import { createClient, type RedisClientType } from 'redis'
import type { RedisQueueTransport } from '../../../packages/workers/src/durable.js'

export async function connectRedisQueue(url: string): Promise<{ transport: RedisQueueTransport; close: () => Promise<void> }> {
  const client = createClient({ url }) as RedisClientType
  await client.connect()
  const transport: RedisQueueTransport = {
    async push(key, value) { await client.lPush(key, value) },
    async pop(key, timeoutSeconds) {
      if (timeoutSeconds <= 0) return (await client.lPop(key)) ?? undefined
      const result = await client.brPop(key, timeoutSeconds)
      return result ? result.element : undefined
    },
  }
  return { transport, close: () => client.quit().then(() => undefined) }
}
