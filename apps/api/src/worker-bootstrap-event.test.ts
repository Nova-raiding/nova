import { expect, it } from 'vitest'
import { createWorkerAuthorizationRuntime } from './worker-authorization-runtime.js'

it('maps manual historical scan enrollment to the exact scan operation with actor recheck', () => {
  const runtime = createWorkerAuthorizationRuntime({} as never)
  expect(runtime.workerEventOperations['asset.scan_bootstrap_requested']).toBe('asset.scan.execute')
  expect(runtime.requiresWorkerActorAuthorization('asset.scan_bootstrap_requested', 'asset.scan.execute')).toBe(true)
  expect(runtime.workerEventOperations['asset.scan_unknown_requested']).toBeUndefined()
})
