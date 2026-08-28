import { describe, expect, it } from 'vitest'
import { runFaultAcceptance } from './fault-acceptance.js'

describe('connector and worker fault acceptance', () => {
  it('proves 429 retry/dead-letter and timeout unknown/reconcile semantics', async () => {
    await expect(runFaultAcceptance()).resolves.toMatchObject({
      profile: 'fault_injection_local',
      connectorTransport: 'stubbed_fetch',
      workerTransport: 'in_memory_runner',
    })
  })
})
