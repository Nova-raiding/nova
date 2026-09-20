/**
 * The one definition of a content generation job's lifecycle states.
 *
 * Both sides of the worker/API boundary have to answer "is this generation job
 * still open for business?", and each kept its own answer in its own app:
 * `apps/api/src/server.ts`'s `generationJobWriteRefused` treated only
 * `succeeded` as un-writable, while `apps/worker/src/main.ts`'s
 * `assertGenerationExecution` treated `succeeded` *and* `failed` as terminal and
 * dead-lettered the outbox event with `GENERATION_JOB_TERMINAL`. The two
 * questions are not the same question — one asks whether the domain service
 * refused a write, the other whether an execution may still start — but every
 * state list behind them is defined here, once, so a change to the
 * classification is a single edit both sides see instead of a change that lands
 * on one copy while the other keeps the old semantics.
 *
 * Nothing outside this module may spell a generation state set out again; the
 * registry pins that with a forbidden-reimplementation check
 * (`tests/invariants/brand-visibility-and-terminal-state.invariant.ts`).
 */

/** Every state a content generation job can be in — the same union
 *  `packages/application/src/service.ts` declares as `GenerationJobState`. */
export const GENERATION_JOB_STATES = ['queued', 'running', 'succeeded', 'failed'] as const
export type GenerationJobState = (typeof GENERATION_JOB_STATES)[number]

/**
 * The states an execution may still start from. Any other state means the
 * worker's `generation.requested` event is stale: the job already has an
 * outcome, so no provider call may be made for it.
 */
export const GENERATION_JOB_EXECUTABLE_STATES = ['queued', 'running'] as const

/**
 * The one state the domain service refuses to move a job out of:
 * `completeGeneration`, `failGeneration` and `deferGeneration` all return a
 * `succeeded` job unchanged. `failed` is deliberately not in this set —
 * `retryGeneration` and `deferGeneration` legitimately move a failed job back
 * to `queued`, so a write for a failed job is a live write, not a refused one.
 */
export const GENERATION_JOB_TERMINAL_STATES = ['succeeded'] as const

export function isGenerationJobState(state: unknown): state is GenerationJobState {
  return typeof state === 'string' && (GENERATION_JOB_STATES as readonly string[]).includes(state)
}

export function isGenerationJobExecutable(state: unknown): boolean {
  return typeof state === 'string' && (GENERATION_JOB_EXECUTABLE_STATES as readonly string[]).includes(state)
}

/**
 * A job whose outcome is already decided, so a redelivered execution event must
 * not re-run it: `succeeded` is final, and `failed` is only left through the
 * explicit retry/defer paths, which first return the job to `queued` — a
 * redelivered event for a failed job is therefore stale, not a retry.
 */
export function isGenerationJobFinished(state: unknown): boolean {
  return isGenerationJobState(state) && !isGenerationJobExecutable(state)
}

/** Whether the domain service refuses to move a job out of `state`. */
export function isGenerationJobTerminal(state: unknown): boolean {
  return typeof state === 'string' && (GENERATION_JOB_TERMINAL_STATES as readonly string[]).includes(state)
}

/**
 * The single terminal-state guard for the generation job write paths.
 *
 * `succeeded` is terminal in the domain layer: `completeGeneration`,
 * `failGeneration` and `deferGeneration` all refuse to move a job out of it and
 * return the job unchanged (`packages/application/src/service.ts`). The return
 * value alone therefore cannot tell a handler whether its write happened, and
 * every handler that writes after such a call — snapshot, outbox event, usage
 * refund, distributed slot release — has to ask this one function first.
 *
 * The failure this exists for: the worker outbox redelivers a non-2xx report, so
 * a job that already succeeded can receive a late `POST /result` failure or a
 * late `POST /defer`. Without the guard the handler wrote a phantom
 * `generation.failed` / `generation.deferred` event *after*
 * `generation.completed`, refunded settled usage and freed a slot for a
 * delivered job. It was fixed one branch at a time and the `defers` branch was
 * missed, so the decision lives here and every sibling branch consults it.
 */
export function generationJobWriteRefused(job: { state: string }): boolean {
  return isGenerationJobTerminal(job.state)
}
