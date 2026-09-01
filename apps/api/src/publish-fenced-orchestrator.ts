import type {
  FinalizeInteractiveConfirmationTicketInput,
  InteractiveConfirmationTicketRepository,
  InteractiveConfirmationTicketReservation,
  ReserveInteractiveConfirmationTicketInput,
  TransactionalInteractiveConfirmationTicketRepository,
} from '../../../packages/persistence/src/interactive-confirmation-ticket-repository.js'
import type { SqlClient } from '../../../packages/persistence/src/repository.js'

export type PublishTicketRepository = Pick<
  TransactionalInteractiveConfirmationTicketRepository,
  'reserve' | 'release' | 'finalizeInTransaction'
>

export interface PublishWalletCompensation {
  debit: () => Promise<void>
  refund: () => Promise<void>
}

export interface PublishSlotCompensation {
  reserve: () => Promise<void>
  release: () => Promise<void>
}

export type PublishPersistOutcome<T> =
  | { status: 'committed'; value: T }
  | { status: 'not_committed'; error?: unknown }

export interface PublishFencedOrchestratorInput<T> {
  ticketRepository: PublishTicketRepository
  ticket: ReserveInteractiveConfirmationTicketInput
  consumedOperationId: string
  /** Optional legacy compensation port. Point-required/no-charge publish omits it. */
  wallet?: PublishWalletCompensation
  slot: PublishSlotCompensation
  persist: (input: {
    reservation: InteractiveConfirmationTicketReservation
    finalizeInTransaction: (client: SqlClient) => Promise<void>
  }) => Promise<PublishPersistOutcome<T>>
}

export class PublishTicketReservationUnavailableError extends Error {
  readonly code = 'INTERACTIVE_CONFIRMATION_RESERVATION_UNAVAILABLE'

  constructor() {
    super('interactive confirmation ticket could not be reserved')
    this.name = 'PublishTicketReservationUnavailableError'
  }
}

export class PublishTicketFinalizeFailedError extends Error {
  readonly code = 'INTERACTIVE_CONFIRMATION_FINALIZE_FAILED'

  constructor() {
    super('interactive confirmation ticket could not be finalized')
    this.name = 'PublishTicketFinalizeFailedError'
  }
}

export class PublishCommitStatusUnknownError extends Error {
  readonly code = 'PUBLISH_COMMIT_STATUS_UNKNOWN'

  constructor(cause: unknown) {
    super('publish commit status is unknown; query the existing publish operation before retrying')
    this.name = 'PublishCommitStatusUnknownError'
    this.cause = cause
  }
}

/**
 * Orchestrates one already-validated publish operation.
 *
 * `persist` owns the database transaction. It must call the supplied
 * `finalizeInTransaction` with that transaction's client after writing the
 * publish snapshots/outbox and before returning `committed`. A rejected
 * persist call is deliberately treated as commit-status-unknown: no wallet,
 * slot, or ticket compensation is safe after a connection-level failure.
 */
export async function runFencedSinglePublish<T>(input: PublishFencedOrchestratorInput<T>): Promise<T> {
  const reservation = await input.ticketRepository.reserve(input.ticket)
  if (!reservation) throw new PublishTicketReservationUnavailableError()

  let walletDebited = false
  let slotReserved = false
  let durableCommitted = false

  const releaseKnownFailure = async (cause: unknown) => {
    const compensationErrors: unknown[] = []
    if (slotReserved) {
      try { await input.slot.release() } catch (error) { compensationErrors.push(error) }
    }
    if (walletDebited && input.wallet) {
      try { await input.wallet.refund() } catch (error) { compensationErrors.push(error) }
    }
    try {
      const released = await input.ticketRepository.release({
        ...input.ticket,
        ...reservation,
      })
      if (!released) compensationErrors.push(new Error('interactive confirmation reservation was not released'))
    } catch (error) {
      compensationErrors.push(error)
    }
    if (compensationErrors.length > 0 && cause instanceof Error) {
      Object.defineProperty(cause, 'compensationErrors', { value: compensationErrors, enumerable: false })
    }
  }

  try {
    if (input.wallet) {
      await input.wallet.debit()
      walletDebited = true
    }
    await input.slot.reserve()
    slotReserved = true

    let outcome: PublishPersistOutcome<T>
    try {
      outcome = await input.persist({
        reservation,
        finalizeInTransaction: async (client) => {
          const finalized = await input.ticketRepository.finalizeInTransaction(client, {
            ...input.ticket,
            ...reservation,
            consumedOperationId: input.consumedOperationId,
          } satisfies FinalizeInteractiveConfirmationTicketInput)
          if (!finalized) throw new PublishTicketFinalizeFailedError()
        },
      })
    } catch (error) {
      // A failed finalize is a known, pre-commit failure. Preserve it so the
      // normal compensation path can release the lease and side effects.
      if (error instanceof PublishTicketFinalizeFailedError) throw error
      throw new PublishCommitStatusUnknownError(error)
    }

    if (outcome.status === 'not_committed') {
      throw outcome.error instanceof Error ? outcome.error : new Error('publish was not committed')
    }

    durableCommitted = true
    return outcome.value
  } catch (error) {
    if (!durableCommitted && !(error instanceof PublishCommitStatusUnknownError)) await releaseKnownFailure(error)
    throw error
  }
}

// Keep the repository import in the public module boundary intentional: the
// helper must not acquire HTTP, MCP, or batch protocol types.
export type { InteractiveConfirmationTicketRepository }
