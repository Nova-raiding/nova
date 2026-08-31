import type { RedisClientOptions } from 'redis'

const DEFAULT_CONNECT_TIMEOUT_MS = 1_000
const DEFAULT_OPERATION_TIMEOUT_MS = 1_500

function positiveMilliseconds(raw: string | undefined, fallback: number): number {
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : fallback
}

export function redisClientOptions(url: string, env: NodeJS.ProcessEnv = process.env): RedisClientOptions {
  return {
    url,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: positiveMilliseconds(env.REDIS_CONNECT_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS),
      reconnectStrategy: retries => Math.min(50 * 2 ** Math.min(retries, 5), 1_000),
    },
  }
}

export async function withRedisOperationTimeout<T>(operation: Promise<T>, env: NodeJS.ProcessEnv = process.env): Promise<T> {
  const timeoutMs = positiveMilliseconds(env.REDIS_OPERATION_TIMEOUT_MS, DEFAULT_OPERATION_TIMEOUT_MS)
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(Object.assign(new Error(`Redis operation timed out after ${timeoutMs}ms`), { code: 'REDIS_OPERATION_TIMEOUT' })), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
