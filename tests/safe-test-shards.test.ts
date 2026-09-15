import { describe, expect, it, vi } from 'vitest'
import { runSafeTestShards, safeTestShardCount } from '../scripts/run-safe-tests-sharded.js'

describe('safe sharded test launcher', () => {
  it('uses eight bounded sequential shards by default', async () => {
    const runShard = vi.fn(async (_args: readonly string[], _source?: NodeJS.ProcessEnv) => 0)
    const messages: string[] = []
    const files = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts', 'e.test.ts', 'f.test.ts', 'g.test.ts', 'h.test.ts', 'i.test.ts']

    await expect(runSafeTestShards(['--no-file-parallelism'], {}, runShard, message => messages.push(message), async () => files)).resolves.toBe(0)

    expect(runShard.mock.calls.map(call => call[0])).toEqual([
      ['a.test.ts', 'i.test.ts', '--no-file-parallelism'],
      ['b.test.ts', '--no-file-parallelism'],
      ['c.test.ts', '--no-file-parallelism'],
      ['d.test.ts', '--no-file-parallelism'],
      ['e.test.ts', '--no-file-parallelism'],
      ['f.test.ts', '--no-file-parallelism'],
      ['g.test.ts', '--no-file-parallelism'],
      ['h.test.ts', '--no-file-parallelism'],
    ])
    expect(messages.at(-1)).toBe('[safe-tests] all 8 shards passed')
  })

  it('runs later shards after a failure and returns the first failing exit code', async () => {
    const runShard = vi.fn()
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(new Error('spawn failed'))
    const messages: string[] = []

    await expect(runSafeTestShards([], { SAFE_TEST_SHARD_COUNT: '3' }, runShard, message => messages.push(message), async () => ['a.test.ts', 'b.test.ts', 'c.test.ts'])).resolves.toBe(7)
    expect(runShard).toHaveBeenCalledTimes(3)
    expect(messages).toContain('[safe-tests] shard 3/3 launcher error: spawn failed')
    expect(messages.at(-1)).toBe('[safe-tests] failed shards: 1/3 (exit 7), 3/3 (exit 1)')
  })

  it('rejects invalid shard counts before starting tests', () => {
    expect(() => safeTestShardCount({ SAFE_TEST_SHARD_COUNT: '0' })).toThrow(/between 1 and 16/u)
    expect(() => safeTestShardCount({ SAFE_TEST_SHARD_COUNT: '2.5' })).toThrow(/between 1 and 16/u)
    expect(() => safeTestShardCount({ SAFE_TEST_SHARD_COUNT: 'many' })).toThrow(/between 1 and 16/u)
  })
})
