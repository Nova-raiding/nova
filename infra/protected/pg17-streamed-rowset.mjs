// Reads a PostgreSQL C-collated result with pg row events. The pg client must
// already be inside the runner's imported, read-only snapshot transaction.
import { createHash } from 'node:crypto'
import pg from 'pg'

const MAX_RECORD_BYTES = 16 * 1024 * 1024
const DOMAIN = Buffer.from('pg17-canonical-rows/1\0', 'utf8')
const check = (condition, message) => { if (!condition) throw new Error(message) }

export function sortedRowsetSql(schema, table, columns, maxRows) {
  const name = /^[a-z_][a-z0-9_]{0,62}$/u
  check(name.test(schema ?? '') && name.test(table ?? '') && Array.isArray(columns) && columns.length > 0 && columns.every(column => name.test(column ?? '')), 'streamed relation or columns invalid')
  check(maxRows === undefined || (Number.isSafeInteger(maxRows) && maxRows > 0 && maxRows < Number.MAX_SAFE_INTEGER), 'streamed row bound invalid')
  const expressions = columns.map(column => `t."${column}"`).join(', ')
  return `SELECT canonical_row FROM (SELECT json_build_array(${expressions})::text AS canonical_row FROM "${schema}"."${table}" AS t) AS encoded ORDER BY canonical_row COLLATE "C"${maxRows === undefined ? '' : ` LIMIT ${maxRows + 1}`}`
}

export function digestSortedPgRows(client, sql, { maxRows = Number.MAX_SAFE_INTEGER } = {}) {
  check(client && typeof client.query === 'function' && typeof sql === 'string' && sql.startsWith('SELECT canonical_row FROM (') && Number.isSafeInteger(maxRows) && maxRows > 0, 'streamed query input invalid')
  return new Promise((resolve, reject) => {
    const query = new pg.Query({ text: sql, rowMode: 'array' })
    const digest = createHash('sha256').update(DOMAIN)
    let previous, count = 0, failure
    query.on('row', row => {
      if (failure) return
      try {
        check(Array.isArray(row) && row.length === 1 && typeof row[0] === 'string', 'streamed row encoding invalid')
        const bytes = Buffer.from(row[0], 'utf8')
        check(bytes.length <= MAX_RECORD_BYTES, 'streamed row exceeds record limit')
        check(!previous || Buffer.compare(previous, bytes) <= 0, 'streamed rows are not byte ordered')
        check(count < maxRows, 'streamed row count exceeds reviewed bound')
        const length = Buffer.allocUnsafe(8)
        length.writeBigUInt64BE(BigInt(bytes.length))
        digest.update(length).update(bytes)
        previous = bytes
        count += 1
      } catch (error) { failure = error }
    })
    query.once('error', error => { failure ??= error; reject(failure) })
    query.once('end', () => failure ? reject(failure) : resolve({ row_count: count, canonical_rows_sha256: digest.digest('hex') }))
    try { client.query(query) } catch (error) { reject(error) }
  })
}
