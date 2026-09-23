#!/usr/local/bin/node
import { readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
writeFileSync('/state/psql-calls.jsonl', `${JSON.stringify(args)}\n`, { flag: 'a' })
const sql = args[args.indexOf('-c') + 1] ?? ''
if (/pg_class/u.test(sql)) { process.stdout.write('[]\n'); process.exit(0) }
if (/schema_migrations/u.test(sql)) {
  const history = JSON.parse(readFileSync('/state/history.json', 'utf8'))
  process.stdout.write(`${JSON.stringify({ version: 242, history })}\n`); process.exit(0)
}
process.stderr.write('unrecognized psql fixture query\n'); process.exit(64)
