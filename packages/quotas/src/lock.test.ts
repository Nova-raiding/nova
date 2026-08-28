import { describe, expect, it } from 'vitest'
import { InMemoryLeaseLockStore, KeyedLeaseLock } from './lock.js'

describe('keyed lease lock', () => {
  it('serializes concurrent work for the same key and permits different keys', async () => {
    const lock = new KeyedLeaseLock(new InMemoryLeaseLockStore(), { waitMs: 500, pollMs: 1 })
    let active = 0
    let maximum = 0
    const work = (key: string) => lock.run(key, async () => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise(resolve => setTimeout(resolve, 10))
      active -= 1
    })
    await Promise.all([work('same'), work('same'), work('different')])
    expect(maximum).toBe(2)
  })
})
