import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryInteractiveConfirmationTicketRepository } from '../../../packages/persistence/src/interactive-confirmation-ticket-repository.js'
import { server } from './server.js'

type Envelope = {
  data: { result: Record<string, unknown> } | null
  error: { code: string; message: string } | null
}

async function start() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

describe('workspace.interactive.confirm with unknown creative-point balance', () => {
  afterEach(async () => {
    vi.restoreAllMocks()
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('fails closed before issuing or returning an interactive confirmation ticket', async () => {
    const issue = vi.spyOn(MemoryInteractiveConfirmationTicketRepository.prototype, 'issue')
    const workspaceId = `ws_interactive_unknown_${Date.now()}`
    const base = await start()

    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'unknown-balance-actor' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 'unknown-confirm', method: 'workspace.interactive.confirm',
        params: { confirmation: 'I_CONFIRM_INTERACTIVE_WRITES' },
      }),
    })
    const envelope = await response.json() as Envelope

    expect(response.status).toBe(503)
    expect(envelope.error?.code).toBe('CREATIVE_POINTS_UNAVAILABLE')
    expect(envelope.data).toBeNull()
    expect(issue).not.toHaveBeenCalled()
  })
})
