import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'

export type ChargedTextDispatchState = 'claimed' | 'provider_started' | 'outcome_unknown' | 'rejected' | 'response_recorded' | 'repair_required' | 'completed'
export interface ChargedTextDispatchAttempt {
  id: string
  workspaceId: string
  actionKey: string
  eventId: string
  logicalAttempt: number
  transportAttempt: number
  providerAttemptKey: string
  requestBodySha256: string
  ownerToken: string
  state: ChargedTextDispatchState
  providerRequestId?: string
}
type Row = {
  id: string; workspace_id: string; action_key: string; event_id: string; logical_attempt: number;
  transport_attempt: number; provider_attempt_key: string; request_body_sha256: string; owner_token: string;
  state: ChargedTextDispatchState; provider_request_id: string | null
}
const projection = 'id,workspace_id,action_key,event_id,logical_attempt,transport_attempt,provider_attempt_key,request_body_sha256,owner_token,state,provider_request_id'
const sha256 = /^[0-9a-f]{64}$/u
const attemptKey = /^mm-[0-9a-f]{64}$/u
function mapped(row: Row): ChargedTextDispatchAttempt {
  return { id: row.id, workspaceId: row.workspace_id, actionKey: row.action_key, eventId: row.event_id,
    logicalAttempt: row.logical_attempt, transportAttempt: row.transport_attempt,
    providerAttemptKey: row.provider_attempt_key, requestBodySha256: row.request_body_sha256,
    ownerToken: row.owner_token, state: row.state,
    ...(row.provider_request_id ? { providerRequestId: row.provider_request_id } : {}) }
}
function required(value: string, label: string): string {
  if (!value?.trim() || value.length > 255 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`CHARGED_TEXT_DISPATCH_${label}_INVALID`)
  return value
}
export class ChargedTextDispatchAdmissionError extends Error {
  /** Another worker or an unresolved provider attempt may own this action. */
  readonly unknown = true
  readonly reconciliationRequired = true
  constructor(readonly code = 'CHARGED_TEXT_DISPATCH_DENIED') { super(code); this.name = 'ChargedTextDispatchAdmissionError' }
}
/** Runtime role gets only narrow function EXECUTE; admission is serialized in PG. */
export class PostgresChargedTextDispatchRepository {
  constructor(private readonly pool: SqlPool) {}

  async claim(input: { workspaceId: string; actionKey: string; eventId: string; logicalAttempt: number;
    transportAttempt: number; providerAttemptKey: string; requestBodySha256: string }): Promise<ChargedTextDispatchAttempt> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    const actionKey = required(input.actionKey, 'ACTION_KEY')
    const eventId = required(input.eventId, 'EVENT_ID')
    if (!Number.isSafeInteger(input.logicalAttempt) || input.logicalAttempt < 1 || input.logicalAttempt > 3
      || !Number.isSafeInteger(input.transportAttempt) || input.transportAttempt < 1 || input.transportAttempt > 3
      || !attemptKey.test(input.providerAttemptKey) || !sha256.test(input.requestBodySha256)) throw new Error('CHARGED_TEXT_DISPATCH_IDENTITY_INVALID')
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const result = await client.query<Row>(`SELECT ${projection} FROM public.claim_charged_text_dispatch_attempt($1,$2,$3,$4,$5,$6,$7)`,
        [workspaceId, actionKey, eventId, input.logicalAttempt, input.transportAttempt, input.providerAttemptKey, input.requestBodySha256])
      if (!result.rows[0]) throw new ChargedTextDispatchAdmissionError()
      return mapped(result.rows[0])
    })
  }

  async transition(input: { workspaceId: string; id: string; ownerToken: string;
    to: Exclude<ChargedTextDispatchState,'claimed'>; providerRequestId?: string }): Promise<ChargedTextDispatchAttempt> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    const id = required(input.id, 'ID')
    const ownerToken = required(input.ownerToken, 'OWNER_TOKEN')
    const providerRequestId = input.providerRequestId ? required(input.providerRequestId, 'PROVIDER_REQUEST_ID') : null
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const result = await client.query<Row>(`SELECT ${projection} FROM public.transition_charged_text_dispatch_attempt($1,$2,$3,$4,$5)`,
        [workspaceId, id, ownerToken, input.to, providerRequestId])
      if (!result.rows[0]) throw new ChargedTextDispatchAdmissionError('CHARGED_TEXT_DISPATCH_TRANSITION_DENIED')
      return mapped(result.rows[0])
    })
  }
}
