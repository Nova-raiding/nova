// Catalog-only inspection for a frozen rowset plan. No business rows or
// database writes are performed. The caller owns the connection lifecycle.
import { createHash } from 'node:crypto'
import { validateFrozenTablePlan } from './review-only-pg17-snapshot-baseline.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const check = (condition, message) => { if (!condition) throw new Error(message) }

export async function collectFrozenPlanCatalog(client, sourcePolicy, expectedMigrationVersion) {
  check(client && typeof client.query === 'function' && Number.isSafeInteger(expectedMigrationVersion) && expectedMigrationVersion > 0, 'catalog inspection input invalid')
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try {
    const identityResult = await client.query("SELECT (pg_control_system()).system_identifier::text AS system_identifier, (SELECT oid FROM pg_database WHERE datname = current_database())::integer AS database_oid, current_database() AS database_name, (SELECT max(version) FROM public.schema_migrations)::integer AS migration_version, current_setting('transaction_read_only') AS read_only")
    check(identityResult?.rows?.length === 1, 'catalog source identity missing')
    const identity = identityResult.rows[0]
    check(identity.read_only === 'on' && /^\d{1,32}$/u.test(identity.system_identifier ?? '') && Number.isInteger(Number(identity.database_oid)) && Number(identity.database_oid) > 0 && typeof identity.database_name === 'string' && identity.database_name.length > 0 && Number(identity.migration_version) === expectedMigrationVersion, 'catalog source differs from reviewed migration')
    const observedPolicy = { system_identifier_sha256: sha(identity.system_identifier), database_oid: Number(identity.database_oid), database_name: identity.database_name }
    if (sourcePolicy) check(JSON.stringify(observedPolicy) === JSON.stringify(sourcePolicy), 'catalog source differs from reviewed policy')
    const result = await client.query("SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind, a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS data_type, a.attnotnull AS not_null FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace LEFT JOIN pg_attribute AS a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped WHERE c.relkind IN ('r', 'p', 'm', 'f') AND n.nspname <> 'information_schema' AND left(n.nspname, 3) <> 'pg_' ORDER BY n.nspname, c.relname, a.attnum")
    check(Array.isArray(result?.rows) && result.rows.length > 0, 'catalog table list missing')
    const tables = []
    let current
    for (const row of result.rows) {
      check(row.kind === 'r' || row.kind === 'p', 'unsupported user relation kind')
      const name = `${row.schema}.${row.name}`
      if (!current || `${current.schema}.${current.name}` !== name) { current = { schema: row.schema, name: row.name, columns: [] }; tables.push(current) }
      check(typeof row.column_name === 'string', `table has no physical columns: ${name}`)
      current.columns.push({ name: row.column_name, data_type: row.data_type, not_null: row.not_null })
    }
    validateFrozenTablePlan(tables)
    await client.query('ROLLBACK')
    return { source_policy: observedPolicy, source_database_id_sha256: observedPolicy.system_identifier_sha256, database_oid: observedPolicy.database_oid, database_name: observedPolicy.database_name, migration_version: expectedMigrationVersion, table_plan: tables }
  } catch (error) { try { await client.query('ROLLBACK') } catch {} throw error }
}
