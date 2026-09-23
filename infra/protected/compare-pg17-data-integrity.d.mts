export type Pg17RowsetTable = { name: string; row_count: number; canonical_rows_sha256: string; rls_policy_sha256: string }
export type Pg17RowsetInventory = {
  schema_version: 'pg17-rowset-inventory/1'
  kind: 'live-backup-baseline' | 'isolated-restore-observation'
  simulated: boolean
  release_id: string
  backup_sha256: string
  database_id_sha256: string
  observed_at: string
  tables: Pg17RowsetTable[]
}
export type Pg17RestoreCaptureIdentity = {
  schema_version: 'pg17-isolated-restore-capture/1'
  status: string
  simulated: boolean
  release_id: string
  backup_sha256: string
  source_database_id_sha256: string
  target_database_id_sha256: string
  captured_at: string
}
export function comparePg17DataIntegrity(
  baseline: Pg17RowsetInventory,
  restored: Pg17RowsetInventory,
  capture: Pg17RestoreCaptureIdentity,
): { status: 'pass' | 'fail'; compared_table_count: number; mismatched_tables: string[] }
