import { err, ok, type Result } from './result.js'

/**
 * Capacity policy for human-service commitments in the next 30 days.
 *
 * The sales gate is deliberately based on minutes rather than bookings: a
 * short consultation and a long training session must consume the same unit
 * of capacity accounting. The 80% threshold is inclusive, so reaching the
 * threshold blocks another commitment.
 */
export interface ServiceCapacityGateInput {
  readonly schedulableMinutes: number
  readonly committedMinutes: number
  readonly requestedMinutes: number
  readonly thresholdPercent?: number
}

export interface ServiceCapacityGate {
  readonly allowed: boolean
  readonly schedulableMinutes: number
  readonly committedMinutes: number
  readonly requestedMinutes: number
  readonly projectedMinutes: number
  readonly thresholdMinutes: number
  readonly utilizationPercent: number
  readonly reason?: 'capacity_available' | 'capacity_threshold_reached'
}

const isWholeNonNegative = (value: number): boolean => Number.isSafeInteger(value) && value >= 0

/**
 * Decide whether a new service commitment fits below the sales capacity cap.
 * No mutation is performed here; callers must persist the decision and their
 * booking/allocation atomically with their own revision/idempotency guard.
 */
export const evaluateServiceCapacityGate = (input: ServiceCapacityGateInput): Result<ServiceCapacityGate> => {
  const thresholdPercent = input.thresholdPercent ?? 80
  if (!isWholeNonNegative(input.schedulableMinutes) || input.schedulableMinutes === 0) {
    return err('SERVICE_CAPACITY_INVALID', 'schedulableMinutes must be a positive safe integer', { field: 'schedulableMinutes' })
  }
  if (!isWholeNonNegative(input.committedMinutes)) {
    return err('SERVICE_CAPACITY_INVALID', 'committedMinutes must be a non-negative safe integer', { field: 'committedMinutes' })
  }
  if (!isWholeNonNegative(input.requestedMinutes) || input.requestedMinutes === 0) {
    return err('SERVICE_CAPACITY_INVALID', 'requestedMinutes must be a positive safe integer', { field: 'requestedMinutes' })
  }
  if (!Number.isSafeInteger(thresholdPercent) || thresholdPercent <= 0 || thresholdPercent > 100) {
    return err('SERVICE_CAPACITY_INVALID', 'thresholdPercent must be an integer between 1 and 100', { field: 'thresholdPercent' })
  }

  const thresholdMinutes = Math.floor(input.schedulableMinutes * thresholdPercent / 100)
  const projectedMinutes = input.committedMinutes + input.requestedMinutes
  if (!Number.isSafeInteger(projectedMinutes)) {
    return err('SERVICE_CAPACITY_INVALID', 'projected service minutes exceed safe integer range', { field: 'requestedMinutes' })
  }
  const utilizationPercent = Number(((projectedMinutes * 100) / input.schedulableMinutes).toFixed(2))
  const allowed = projectedMinutes < thresholdMinutes
  return ok({
    allowed,
    schedulableMinutes: input.schedulableMinutes,
    committedMinutes: input.committedMinutes,
    requestedMinutes: input.requestedMinutes,
    projectedMinutes,
    thresholdMinutes,
    utilizationPercent,
    reason: allowed ? 'capacity_available' : 'capacity_threshold_reached',
  })
}
