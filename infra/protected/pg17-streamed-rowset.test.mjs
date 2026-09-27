import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalRowsDigest } from './pg17-rowset-canonical.mjs'
import { digestSortedPgRows, sortedRowsetSql } from './pg17-streamed-rowset.mjs'

function clientFor(rows, error) {
  return { query(query) { queueMicrotask(() => { for (const row of rows) query.emit('row', [row]); if (error) query.emit('error', error); else query.emit('end') }) } }
}

test('streams C-ordered row bytes with duplicate preservation and constant retained row state', async () => {
  const rows = ['["a"]', '["a"]', '["b"]']
  const sql = sortedRowsetSql('public', 'merchants', ['id'], 10)
  assert.match(sql, /ORDER BY canonical_row COLLATE "C" LIMIT 11$/u)
  const result = await digestSortedPgRows(clientFor(rows), sql, { maxRows: 10 })
  assert.deepEqual(result, canonicalRowsDigest(rows.map(row => Buffer.from(row))))
})

test('rejects bad ordering, excess rows, oversized values, and database error', async () => {
  const sql = sortedRowsetSql('public', 'merchants', ['id'])
  await assert.rejects(digestSortedPgRows(clientFor(['b', 'a']), sql), /not byte ordered/u)
  await assert.rejects(digestSortedPgRows(clientFor(['a', 'b']), sql, { maxRows: 1 }), /count exceeds/u)
  await assert.rejects(digestSortedPgRows(clientFor(['x'.repeat(16 * 1024 * 1024 + 1)]), sql), /record limit/u)
  await assert.rejects(digestSortedPgRows(clientFor([], new Error('database failed')), sql), /database failed/u)
})

test('rejects SQL identifier injection before building a query', () => {
  assert.throws(() => sortedRowsetSql('public', 'merchants;drop', ['id']), /relation or columns invalid/u)
  assert.throws(() => sortedRowsetSql('public', 'merchants', ['id);drop']), /relation or columns invalid/u)
  assert.throws(() => sortedRowsetSql('public', 'merchants', ['id'], Number.MAX_SAFE_INTEGER), /row bound invalid/u)
})
