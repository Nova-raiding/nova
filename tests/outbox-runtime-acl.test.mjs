import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('outbox bootstrap grants execution reservation only when migration 276 column exists', async () => {
  const sql = await readFile(new URL('../infra/local/ensure-app-role.sql', import.meta.url), 'utf8')
  const block = sql.match(/IF to_regclass\('public\.outbox_events'\) IS NOT NULL THEN([\s\S]*?)\n  END IF;/)?.[1]
  assert.ok(block)
  assert.match(block, /REVOKE UPDATE, DELETE, TRUNCATE ON TABLE outbox_events FROM merchant_app/)
  assert.match(block, /GRANT UPDATE \(published_at,attempts,next_attempt_at,lease_token,lease_until,last_error,unknown_at\)/)
  assert.match(block, /IF EXISTS \([\s\S]*pg_catalog\.pg_attribute[\s\S]*attrelid = 'public\.outbox_events'::regclass[\s\S]*attname = 'execution_owner' AND NOT attisdropped[\s\S]*\) THEN\s*EXECUTE 'GRANT UPDATE \(execution_owner\) ON TABLE outbox_events TO merchant_app';\s*END IF;/)
  assert.doesNotMatch(block, /GRANT UPDATE ON TABLE/)
})
