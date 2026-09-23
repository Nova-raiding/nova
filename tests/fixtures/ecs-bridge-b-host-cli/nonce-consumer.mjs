#!/usr/local/bin/node
import { existsSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
const args = process.argv.slice(2)
const value = key => args.includes(key) ? args[args.indexOf(key) + 1] : undefined
if (args[0] !== 'consume') process.exit(64)
const operation = value('--operation') ?? 'deployment'
const attemptId = value('--attempt-id') ?? ''
writeFileSync('/state/nonce-calls.jsonl', `${JSON.stringify(args)}\n`, { flag: 'a' })
if (!['deployment', 'bridge-b'].includes(operation) || operation === 'deployment' && attemptId || operation === 'bridge-b' && !/^[A-Za-z0-9_-]{16,128}$/.test(attemptId)) {
  process.stderr.write('nonce rejected: operation ownership contract is invalid\n')
  process.exit(1)
}
const db = new DatabaseSync('/var/lib/merchant-release-security/production-nonces.sqlite3')
try {
  db.exec('BEGIN IMMEDIATE')
  db.exec('CREATE TABLE IF NOT EXISTS nonce_owners(namespace TEXT NOT NULL, nonce TEXT NOT NULL, operation TEXT NOT NULL, attempt_id TEXT NOT NULL DEFAULT "", PRIMARY KEY(namespace, nonce))')
  db.prepare('INSERT INTO consumed_nonces(namespace,nonce,release_id,image_digest,manifest_sha256,release_git_sha) VALUES(?,?,?,?,?,?)')
    .run(value('--namespace'), value('--nonce'), value('--release-id'), value('--image-digest'), value('--manifest-sha256'), value('--release-git-sha'))
  db.prepare('INSERT INTO nonce_owners(namespace,nonce,operation,attempt_id) VALUES(?,?,?,?)')
    .run(value('--namespace'), value('--nonce'), operation, attemptId)
  db.exec('COMMIT')
  if (existsSync('/state/fail-nonce-after-commit')) {
    process.stderr.write('simulated process loss after nonce ledger commit\n')
    process.exitCode = 79
  } else process.stdout.write('nonce accepted\n')
} catch (error) { try { db.exec('ROLLBACK') } catch {}; process.stderr.write(`nonce rejected: ${error.message}\n`); process.exitCode = 1 }
finally { db.close() }
