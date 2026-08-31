-- 053_terminal_generation_outbox_cleanup: close historical generation requests
-- whose durable generation job already reached a terminal state.
--
-- This is intentionally narrower than a generic outbox cleanup. A row is
-- terminalized only when the tenant, aggregate id, and typed payload job id
-- all identify the same succeeded/failed generation job. Ambiguous or
-- malformed events remain untouched for operator review.

WITH terminal_generation_events AS (
  SELECT event.id,
         event.workspace_id,
         job.state AS generation_state
    FROM outbox_events event
    JOIN generation_jobs job
      ON job.workspace_id = event.workspace_id
     AND job.id = event.aggregate_id
   WHERE event.event_type = 'generation.requested'
     AND event.published_at IS NULL
     AND job.state IN ('succeeded', 'failed')
     AND jsonb_typeof(event.payload) = 'object'
     AND jsonb_typeof(event.payload->'job_id') = 'string'
     AND event.payload->>'job_id' = event.aggregate_id
)
UPDATE outbox_events event
   SET published_at = now(),
       next_attempt_at = LEAST(event.next_attempt_at, now()),
       lease_token = NULL,
       lease_until = NULL,
       last_error = CASE
         WHEN event.last_error->>'code' = 'GENERATION_JOB_TERMINAL'
          AND event.last_error->'retryable' = 'false'::jsonb
         THEN event.last_error
         ELSE jsonb_strip_nulls(jsonb_build_object(
           'code', 'GENERATION_JOB_TERMINAL',
           'message', 'Generation request closed because its durable job is already terminal',
           'retryable', false,
           'generationState', terminal.generation_state,
           'previousError', event.last_error
         ))
       END
  FROM terminal_generation_events terminal
 WHERE event.workspace_id = terminal.workspace_id
   AND event.id = terminal.id
   AND event.published_at IS NULL;
