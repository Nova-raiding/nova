import { describe, expect, it, vi } from 'vitest'
import type { SqlClient } from '../../../packages/persistence/src/repository.js'
import {
  PublishCommitStatusUnknownError,
  PublishTicketFinalizeFailedError,
  PublishTicketReservationUnavailableError,
  runFencedSinglePublish,
} from './publish-fenced-orchestrator.js'

const ticket = {
  workspaceId: 'workspace-1', actorId: 'actor-1', sessionId: 'session-1', intentHash: 'a'.repeat(64), nonceHash: 'b'.repeat(64),
  reservationId: 'publish:job-1', reservationToken: 'c'.repeat(64), reservationExpiresAt: '2026-09-01T00:10:00.000Z',
}
const reservation = { reservationId: ticket.reservationId, reservationToken: ticket.reservationToken, reservationRevision: 3 }
const client = {} as SqlClient

function harness() {
  const calls: string[] = []
  const ticketRepository = {
    reserve: vi.fn(async () => { calls.push('ticket.reserve'); return reservation }),
    release: vi.fn(async () => { calls.push('ticket.release'); return true }),
    finalizeInTransaction: vi.fn(async () => { calls.push('ticket.finalize') ; return true }),
  }
  const wallet = { debit: vi.fn(async () => { calls.push('wallet.debit') }), refund: vi.fn(async () => { calls.push('wallet.refund') }) }
  const slot = { reserve: vi.fn(async () => { calls.push('slot.reserve') }), release: vi.fn(async () => { calls.push('slot.release') }) }
  return { calls, ticketRepository, wallet, slot }
}

describe('runFencedSinglePublish', () => {
  it('reserves, finalizes on the persist transaction client, and commits', async () => {
    const h = harness()
    const result = await runFencedSinglePublish({
      ticketRepository: h.ticketRepository, ticket, consumedOperationId: 'job-1', wallet: h.wallet, slot: h.slot,
      persist: async ({ reservation: actual, finalizeInTransaction }) => {
        expect(actual).toEqual(reservation)
        await finalizeInTransaction(client)
        return { status: 'committed', value: { jobId: 'job-1' } }
      },
    })
    expect(result).toEqual({ jobId: 'job-1' })
    expect(h.ticketRepository.finalizeInTransaction).toHaveBeenCalledWith(client, expect.objectContaining({ ...reservation, consumedOperationId: 'job-1' }))
    expect(h.calls).toEqual(['ticket.reserve', 'wallet.debit', 'slot.reserve', 'ticket.finalize'])
    expect(h.ticketRepository.release).not.toHaveBeenCalled()
  })

  it('fails closed when reservation is unavailable without side effects', async () => {
    const h = harness()
    h.ticketRepository.reserve.mockImplementation(async () => undefined as never)
    await expect(runFencedSinglePublish({ ticketRepository: h.ticketRepository, ticket, consumedOperationId: 'job-1', wallet: h.wallet, slot: h.slot, persist: vi.fn() })).rejects.toBeInstanceOf(PublishTicketReservationUnavailableError)
    expect(h.wallet.debit).not.toHaveBeenCalled()
    expect(h.slot.reserve).not.toHaveBeenCalled()
  })

  it('releases in reverse order after a known non-commit', async () => {
    const h = harness()
    const error = new Error('validation failed')
    await expect(runFencedSinglePublish({
      ticketRepository: h.ticketRepository, ticket, consumedOperationId: 'job-1', wallet: h.wallet, slot: h.slot,
      persist: async () => ({ status: 'not_committed', error }),
    })).rejects.toBe(error)
    expect(h.calls).toEqual(['ticket.reserve', 'wallet.debit', 'slot.reserve', 'slot.release', 'wallet.refund', 'ticket.release'])
  })

  it('releases wallet and ticket when slot reservation fails', async () => {
    const h = harness()
    h.slot.reserve.mockRejectedValue(new Error('capacity'))
    await expect(runFencedSinglePublish({ ticketRepository: h.ticketRepository, ticket, consumedOperationId: 'job-1', wallet: h.wallet, slot: h.slot, persist: vi.fn() })).rejects.toThrow('capacity')
    expect(h.calls).toEqual(['ticket.reserve', 'wallet.debit', 'wallet.refund', 'ticket.release'])
  })

  it('does not compensate after persist throws with unknown commit status', async () => {
    const h = harness()
    await expect(runFencedSinglePublish({
      ticketRepository: h.ticketRepository, ticket, consumedOperationId: 'job-1', wallet: h.wallet, slot: h.slot,
      persist: async () => { throw new Error('connection lost') },
    })).rejects.toBeInstanceOf(PublishCommitStatusUnknownError)
    expect(h.wallet.refund).not.toHaveBeenCalled()
    expect(h.slot.release).not.toHaveBeenCalled()
    expect(h.ticketRepository.release).not.toHaveBeenCalled()
  })

  it('turns a failed finalize into a known non-commit and compensates', async () => {
    const h = harness()
    h.ticketRepository.finalizeInTransaction.mockImplementation(async () => { h.calls.push('ticket.finalize'); return false })
    await expect(runFencedSinglePublish({
      ticketRepository: h.ticketRepository, ticket, consumedOperationId: 'job-1', wallet: h.wallet, slot: h.slot,
      persist: async ({ finalizeInTransaction }) => { await finalizeInTransaction(client); return { status: 'committed', value: 'unreachable' } },
    })).rejects.toBeInstanceOf(PublishTicketFinalizeFailedError)
    expect(h.calls).toEqual(['ticket.reserve', 'wallet.debit', 'slot.reserve', 'ticket.finalize', 'slot.release', 'wallet.refund', 'ticket.release'])
  })
})
