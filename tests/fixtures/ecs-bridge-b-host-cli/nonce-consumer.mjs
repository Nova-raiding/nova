#!/usr/local/bin/node
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
const args = process.argv.slice(2)
const value = key => args[args.indexOf(key) + 1]
if (args[0] !== 'consume') process.exit(64)
const db = new DatabaseSync('/var/lib/merchant-release-security/production-nonces.sqlite3')
try {
  db.prepare('INSERT INTO consumed_nonces(namespace,nonce,release_id,image_digest,manifest_sha256,release_git_sha) VALUES(?,?,?,?,?,?)')
    .run(value('--namespace'), value('--nonce'), value('--release-id'), value('--image-digest'), value('--manifest-sha256'), value('--release-git-sha'))
  if (existsSync('/state/fail-nonce-after-commit')) {
    process.stderr.write('simulated process loss after nonce ledger commit\n')
    process.exitCode = 79
  } else process.stdout.write('nonce accepted\n')
} catch (error) { process.stderr.write(`nonce rejected: ${error.message}\n`); process.exitCode = 1 }
finally { db.close() }
