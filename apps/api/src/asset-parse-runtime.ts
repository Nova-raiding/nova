import { runWithAssetParseDeadline } from '../../../packages/application/src/asset-parse-lifecycle.js'
import { AssetParseRepositoryError, type AssetParseRecord, type AssetParseRepository } from '../../../packages/persistence/src/asset-parse-repository.js'

export class AssetParseExecutionError extends Error {
  constructor(readonly code: string, message: string, readonly record?: Extract<AssetParseRecord, { state: 'failed' }>, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AssetParseExecutionError'
  }
}

export interface ExecuteAssetParseInput {
  repository: AssetParseRepository
  workspaceId: string
  assetId: string
  timeoutMs: number
  maxAttempts?: number
  callerSignal?: AbortSignal
  onClaim?: (record: Extract<AssetParseRecord, { state: 'processing' }>) => Promise<void>
  parse: (signal: AbortSignal) => Promise<Record<string, unknown>>
  classifyFailure?: (error: unknown) => { code: string; message: string; retryable: boolean }
}

// The execution deadline and the durable lease serve different purposes. Keep
// the lease briefly after the parser deadline so the owner can persist the
// timeout outcome before another worker is allowed to reclaim the asset.
const FAILURE_SETTLEMENT_GRACE_MS = 5_000
const MAX_PARSE_LEASE_MS = 24 * 60 * 60 * 1_000

export async function executeAssetParse(input: ExecuteAssetParseInput): Promise<{ record: Extract<AssetParseRecord, { state: 'succeeded' }>; replayed: boolean }> {
  let lease: Extract<AssetParseRecord, { state: 'processing' }>
  try {
    const leaseMs = Math.min(MAX_PARSE_LEASE_MS, input.timeoutMs + FAILURE_SETTLEMENT_GRACE_MS)
    lease = await input.repository.claim({ workspaceId: input.workspaceId, assetId: input.assetId, leaseMs, ...(input.maxAttempts ? { maxAttempts: input.maxAttempts } : {}) })
  } catch (error) {
    if (error instanceof AssetParseRepositoryError && error.code === 'ASSET_PARSE_ALREADY_SUCCEEDED') {
      const current = await input.repository.get({ workspaceId: input.workspaceId, assetId: input.assetId })
      if (current?.state === 'succeeded') return { record: current, replayed: true }
    }
    throw error
  }

  try {
    await input.onClaim?.(lease)
    const facts = await runWithAssetParseDeadline(input.parse, input.timeoutMs, input.callerSignal)
    const record = await input.repository.succeed({ workspaceId: input.workspaceId, assetId: input.assetId, leaseToken: lease.leaseToken, facts })
    return { record, replayed: false }
  } catch (error) {
    if (error instanceof AssetParseRepositoryError && error.code === 'ASSET_PARSE_LEASE_LOST') throw error
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError'
    const failure = timedOut ? defaultFailure(error) : input.classifyFailure?.(error) ?? defaultFailure(error)
    let record: Extract<AssetParseRecord, { state: 'failed' }> | undefined
    try {
      record = timedOut
        ? await input.repository.expire({ workspaceId: input.workspaceId, assetId: input.assetId, leaseToken: lease.leaseToken, now: lease.leaseUntil })
        : await input.repository.fail({ workspaceId: input.workspaceId, assetId: input.assetId, leaseToken: lease.leaseToken, errorCode: failure.code, errorMessage: failure.message, retryable: failure.retryable })
    } catch (failureWriteError) {
      if (failureWriteError instanceof AssetParseRepositoryError && failureWriteError.code === 'ASSET_PARSE_LEASE_LOST') throw failureWriteError
      throw new AssetParseExecutionError('ASSET_PARSE_FAILURE_NOT_RECORDED', 'asset parse failed and its durable failure could not be recorded', undefined, { cause: failureWriteError })
    }
    throw new AssetParseExecutionError(failure.code, failure.message, record, { cause: error })
  }
}

function defaultFailure(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof DOMException && error.name === 'TimeoutError') return { code: 'ASSET_PARSE_TIMEOUT', message: 'asset parse timed out', retryable: true }
  if (error instanceof AssetParseRepositoryError && error.code === 'ASSET_PARSE_EMPTY') return { code: error.code, message: 'asset parser returned no facts', retryable: true }
  const message = error instanceof Error && error.message.trim() ? error.message.trim().slice(0, 1_000) : 'asset parse failed'
  return { code: 'ASSET_PARSE_FAILED', message, retryable: true }
}
