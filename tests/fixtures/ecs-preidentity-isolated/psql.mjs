#!/usr/local/bin/node
import crypto from 'node:crypto'
import fs from 'node:fs'

fs.appendFileSync('/state/psql-argv.jsonl', `${JSON.stringify(process.argv.slice(2))}\n`)
const rows = Array.from({ length: 219 }, (_, index) => [index + 1, `m${index + 1}`, crypto.createHash('sha256').update(`m${index + 1}`).digest('hex')])
const sql = process.argv.at(-1)
process.stdout.write(sql.includes('indisvalid')
  ? `${fs.existsSync('/state/invalid-index') ? '["ops_incident_timeline_workspace_created_id_idx"]' : '[]'}\n`
  : `${JSON.stringify({ version: 219, history: rows })}\n`)
