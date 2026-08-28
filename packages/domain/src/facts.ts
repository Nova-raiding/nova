import { err, ok, type Result } from './result.js'

export type FactState = 'missing' | 'pending_confirmation' | 'confirmed' | 'conflict' | 'restricted' | 'expired'

export interface FactSource {
  readonly type: 'document' | 'official_api' | 'merchant_input' | 'system'
  readonly reference: string
}

export interface FactField<T = unknown> {
  readonly id: string
  readonly fieldPath: string
  readonly value?: T
  readonly source?: FactSource
  readonly state: FactState
  readonly validFrom?: string
  readonly validTo?: string
  readonly confirmedBy?: string
  readonly confirmedAt?: string
  readonly version: number
}

const allowedTransitions: Readonly<Record<FactState, readonly FactState[]>> = {
  missing: ['pending_confirmation'],
  pending_confirmation: ['confirmed', 'conflict', 'restricted', 'missing'],
  confirmed: ['conflict', 'expired', 'missing'],
  conflict: ['pending_confirmation', 'missing', 'restricted'],
  restricted: ['pending_confirmation', 'missing'],
  expired: ['pending_confirmation', 'missing'],
}

const cloneWithState = <T>(fact: FactField<T>, state: FactState, patch: Partial<FactField<T>> = {}): FactField<T> =>
  Object.freeze({ ...fact, ...patch, state, version: fact.version + 1 })

export const transitionFact = <T>(fact: FactField<T>, next: FactState): Result<FactField<T>> => {
  if (next === 'confirmed') {
    return err('FACT_CONFIRMATION_REQUIRED', 'confirmed state requires confirmFact with actor and timestamp')
  }
  if (!allowedTransitions[fact.state].includes(next)) {
    return err('INVALID_FACT_TRANSITION', `fact ${fact.state} cannot transition to ${next}`, { from: fact.state, to: next })
  }
  return ok(cloneWithState(fact, next))
}

export const proposeFact = <T>(fact: FactField<T>, value: T, source: FactSource): Result<FactField<T>> => {
  if (!source.reference.trim()) return err('FACT_CONFIRMATION_REQUIRED', 'a fact proposal must have a source reference')
  if (!['missing', 'conflict', 'restricted', 'expired'].includes(fact.state)) {
    return err('INVALID_FACT_TRANSITION', `fact ${fact.state} cannot be proposed again`)
  }
  return ok(cloneWithState(fact, 'pending_confirmation', { value, source, confirmedBy: undefined, confirmedAt: undefined }))
}

export const confirmFact = <T>(fact: FactField<T>, actorId: string, confirmedAt: string): Result<FactField<T>> => {
  if (fact.state !== 'pending_confirmation') {
    return err('INVALID_FACT_TRANSITION', `only pending_confirmation facts can be confirmed`, { state: fact.state })
  }
  if (fact.value === undefined || !fact.source || !actorId.trim() || !confirmedAt.trim()) {
    return err('FACT_CONFIRMATION_REQUIRED', 'confirmed facts require value, source, actor and timestamp')
  }
  return ok(cloneWithState(fact, 'confirmed', { confirmedBy: actorId, confirmedAt }))
}

export const isFactUsable = <T>(fact: FactField<T>, at: string): Result<T> => {
  if (fact.state !== 'confirmed' || fact.value === undefined) {
    return err('FACT_NOT_USABLE', 'only confirmed facts can be used as formal content inputs', { state: fact.state })
  }
  if (fact.validFrom && fact.validFrom > at) return err('FACT_NOT_USABLE', 'fact is not valid yet')
  if (fact.validTo && fact.validTo <= at) return err('FACT_NOT_USABLE', 'fact validity has expired')
  return ok(fact.value)
}
