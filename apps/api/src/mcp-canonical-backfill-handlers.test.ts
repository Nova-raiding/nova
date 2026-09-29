import type { IncomingMessage } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import { handleMcpCanonicalBackfill } from './mcp-canonical-backfill-handlers.js'

describe('canonical backfill workspace scope', () => {
  it('rejects a missing workspace before persistence access', async () => {
    const requireOperationsRole = vi.fn(() => 'platform_ops')
    const getPersistence = vi.fn(() => { throw new Error('persistence must not be accessed') })
    const deps = {
      persistenceReady: Promise.resolve(), getPersistence, requireOperationsRole,
      requestActor: vi.fn(() => 'actor-id'), recordOperationAudit: vi.fn(),
    }

    await expect(handleMcpCanonicalBackfill(
      'ops.canonical.backfill.conflicts.list', {}, {} as IncomingMessage, '', deps,
    )).rejects.toMatchObject({ code: ERROR_CODES.WORKSPACE_SCOPE_REQUIRED, status: 400 })

    expect(requireOperationsRole).toHaveBeenCalledOnce()
    expect(getPersistence).not.toHaveBeenCalled()
  })
})
