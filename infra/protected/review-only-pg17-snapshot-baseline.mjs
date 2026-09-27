// Review-only prototype for the backup runner's held pg_export_snapshot().
// No CLI, file writer, production adapter, or evidence signer is provided.
import { createHash } from 'node:crypto'
import { canonicalRowsDigest, rlsPolicyDigest } from './pg17-rowset-canonical.mjs'
import { sortedRowsetSql } from './pg17-streamed-rowset.mjs'

const SNAPSHOT = /^[A-Za-z0-9:-]{1,256}$/u
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u
const HEX = /^[a-f0-9]{64}$/u
const hash = value => createHash('sha256').update(value).digest('hex')
const check = (condition, message) => { if (!condition) throw new Error(message) }
const quote = identifier => `"${identifier}"`

export function validateFrozenTablePlan(plan) {
  check(Array.isArray(plan) && plan.length > 0 && plan.length <= 500, 'frozen table plan is missing or excessive')
  const names = new Set()
  for (const table of plan) {
    check(table && IDENTIFIER.test(table.schema ?? '') && IDENTIFIER.test(table.name ?? ''), 'frozen table identifier invalid')
    const name = `${table.schema}.${table.name}`
    check(!names.has(name), 'duplicate frozen table')
    names.add(name)
    check(Array.isArray(table.columns) && table.columns.length > 0 && table.columns.length <= 256, 'frozen table columns invalid')
    const columns = new Set()
    for (const column of table.columns) {
      check(column && IDENTIFIER.test(column.name ?? '') && typeof column.data_type === 'string' && column.data_type.length > 0 && column.data_type.length <= 128 && typeof column.not_null === 'boolean', 'frozen column contract invalid')
      check(!columns.has(column.name), 'duplicate frozen column')
      columns.add(column.name)
    }
  }
  return plan
}

function exactlyOne(result, label) {
  check(Array.isArray(result?.rows) && result.rows.length === 1, `${label} observation missing or ambiguous`)
  return result.rows[0]
}

export async function observeReviewOnlySnapshot({ snapshot, identity, sourcePolicy, tablePlan, connect, streamRows, maxRowsPerTable = 10_000, observedAt = () => new Date().toISOString() }) {
  check(typeof snapshot === 'string' && SNAPSHOT.test(snapshot), 'exported snapshot identifier invalid')
  check(identity && /^\d{1,32}$/u.test(identity.systemIdentifier ?? '') && Number.isInteger(identity.databaseOid) && identity.databaseOid > 0 && typeof identity.databaseName === 'string' && Number.isSafeInteger(identity.migrationVersion), 'runner source identity invalid')
  check(sourcePolicy?.system_identifier_sha256 === hash(identity.systemIdentifier) && sourcePolicy.database_oid === identity.databaseOid && sourcePolicy.database_name === identity.databaseName, 'reviewed source policy mismatch')
  validateFrozenTablePlan(tablePlan)
  // Copy before the first await so a caller cannot change the reviewed plan
  // while the database transaction is sampling it.
  const frozenPlan = tablePlan.map(table => ({ schema: table.schema, name: table.name, columns: table.columns.map(column => ({ name: column.name, data_type: column.data_type, not_null: column.not_null })) }))
  check(Number.isSafeInteger(maxRowsPerTable) && maxRowsPerTable > 0 && maxRowsPerTable <= (streamRows ? 100_000_000 : 100_000) && (!streamRows || typeof streamRows === 'function'), 'row bound or stream adapter invalid')
  check(typeof connect === 'function', 'isolated database connector required')
  const client = await connect()
  check(client && typeof client.query === 'function' && typeof client.end === 'function', 'database connector invalid')
  let begun = false
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    begun = true
    // The runner holds the exporter transaction until this callback returns.
    // No query may precede SET TRANSACTION SNAPSHOT in this transaction.
    await client.query(`SET TRANSACTION SNAPSHOT '${snapshot}'`)
    await client.query('SET LOCAL row_security = off')
    const source = exactlyOne(await client.query("SELECT (pg_control_system()).system_identifier::text AS system_identifier, (SELECT oid FROM pg_database WHERE datname = current_database())::integer AS database_oid, current_database() AS database_name, (SELECT max(version) FROM public.schema_migrations)::integer AS migration_version, current_setting('transaction_read_only') AS read_only"), 'source identity')
    check(source.read_only === 'on' && source.system_identifier === identity.systemIdentifier && Number(source.database_oid) === identity.databaseOid && source.database_name === identity.databaseName && Number(source.migration_version) === identity.migrationVersion, 'snapshot source identity mismatch')
    // The declared plan must cover every user-owned stored relation in this
    // snapshot. Unsupported materialized/foreign relations fail closed.
    const catalog = await client.query("SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p', 'm', 'f') AND n.nspname <> 'information_schema' AND left(n.nspname, 3) <> 'pg_' ORDER BY n.nspname, c.relname")
    check(Array.isArray(catalog?.rows) && catalog.rows.length > 0, 'user relation catalog missing')
    check(catalog.rows.every(row => row.kind === 'r' || row.kind === 'p'), 'unsupported user relation kind')
    const observedRelations = catalog.rows.map(row => `${row.schema}.${row.name}`).sort()
    const plannedRelations = frozenPlan.map(table => `${table.schema}.${table.name}`).sort()
    check(JSON.stringify(observedRelations) === JSON.stringify(plannedRelations), 'frozen table plan does not cover the complete user relation catalog')
    const tables = []
    for (const table of frozenPlan) {
      const relation = `${table.schema}.${table.name}`
      const actualColumns = (await client.query('SELECT attname AS name, format_type(atttypid, atttypmod) AS data_type, attnotnull AS not_null FROM pg_attribute WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped ORDER BY attnum', [relation])).rows
      check(JSON.stringify(actualColumns) === JSON.stringify(table.columns), `frozen column contract changed: ${relation}`)
      const flags = exactlyOne(await client.query('SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class WHERE oid = to_regclass($1) AND relkind IN (\'r\', \'p\')', [relation]), `RLS flags for ${relation}`)
      const policies = (await client.query("SELECT polname AS name, polcmd AS cmd, polpermissive AS permissive, pg_get_expr(polqual, polrelid) AS qual, pg_get_expr(polwithcheck, polrelid) AS with_check, ARRAY(SELECT CASE WHEN role_id = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(role_id) END FROM unnest(polroles) AS policy_role(role_id) ORDER BY 1) AS roles FROM pg_policy WHERE polrelid = to_regclass($1) ORDER BY polname", [relation])).rows
      let rowset
      if (streamRows) {
        const sql = sortedRowsetSql(table.schema, table.name, table.columns.map(column => column.name), maxRowsPerTable)
        rowset = await streamRows(client, sql, { maxRows: maxRowsPerTable })
        check(Number.isSafeInteger(rowset?.row_count) && rowset.row_count >= 0 && rowset.row_count <= maxRowsPerTable && HEX.test(rowset.canonical_rows_sha256 ?? ''), `streamed rowset invalid: ${relation}`)
      } else {
        const expressions = table.columns.map(column => `t.${quote(column.name)}`).join(', ')
        const result = await client.query(`SELECT json_build_array(${expressions})::text AS canonical_row FROM ${quote(table.schema)}.${quote(table.name)} AS t LIMIT $1`, [maxRowsPerTable + 1])
        check(Array.isArray(result?.rows) && result.rows.length <= maxRowsPerTable, `row bound exceeded: ${relation}`)
        const rows = result.rows.map(item => {
          check(typeof item.canonical_row === 'string', `row encoding invalid: ${relation}`)
          return Buffer.from(item.canonical_row, 'utf8')
        })
        rowset = canonicalRowsDigest(rows)
      }
      tables.push({ name: relation, ...rowset, rls_policy_sha256: rlsPolicyDigest({ enabled: flags.enabled, forced: flags.forced, policies }) })
    }
    const time = observedAt()
    check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(time) && Number.isFinite(Date.parse(time)), 'observation time invalid')
    await client.query('ROLLBACK')
    begun = false
    return Object.freeze({ schema_version: 'pg17-review-only-snapshot-baseline/1', final_production_evidence: false, source_provenance_verified: false, sampling_mode: streamRows ? 'streamed_pg_rows' : 'bounded_batch', snapshot_id_sha256: hash(snapshot), database_id_sha256: hash(identity.systemIdentifier), migration_version: identity.migrationVersion, table_plan_sha256: hash(JSON.stringify(frozenPlan)), row_canonicalization: 'pg17-canonical-rows/1', rls_canonicalization: 'pg17-rls-policy/1', observed_at: time, tables })
  } finally {
    if (begun) try { await client.query('ROLLBACK') } catch { /* Preserve the original failure. */ }
    await client.end()
  }
}

export function bindReviewOnlyBaseline(observation, attestation) {
  check(observation?.schema_version === 'pg17-review-only-snapshot-baseline/1' && observation.final_production_evidence === false && observation.source_provenance_verified === false, 'review-only observation required')
  // This checks identity fields only. An independent verifier must validate
  // the Ed25519 signature, producer binary and protected file provenance.
  check(attestation?.schema_version === '2' && attestation.kind === 'postgres_backup' && attestation.simulated === false && HEX.test(attestation.backup_sha256 ?? '') && HEX.test(attestation.snapshot_id_sha256 ?? ''), 'backup document metadata required')
  check(observation.snapshot_id_sha256 === attestation.snapshot_id_sha256 && observation.database_id_sha256 === attestation.source_database_id_sha256 && observation.migration_version === attestation.migration_version, 'observation and backup source mismatch')
  return Object.freeze({ ...observation, backup_sha256: attestation.backup_sha256, final_production_evidence: false, source_provenance_verified: false, backup_document_signature_verified: false })
}
