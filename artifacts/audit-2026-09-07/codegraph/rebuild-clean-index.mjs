// Reproduce the audit with the installed CodeGraph 1.5.0 library.
// Writes only the explicitly supplied fresh database, never the project index.
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const library = '/opt/homebrew/lib/node_modules/@colbymchenry/codegraph/node_modules/@colbymchenry/codegraph-darwin-arm64/lib/dist'
const { DatabaseConnection, QueryBuilder } = require(`${library}/index.js`)
const { ExtractionOrchestrator } = require(`${library}/extraction/index.js`)
const { createResolver } = require(`${library}/resolution/index.js`)
const root = process.cwd()
const auditDirectory = path.resolve('artifacts/audit-2026-09-07/codegraph')
const dbPath = path.resolve(process.argv[2] ?? path.join(auditDirectory, 'clean-codegraph.db'))
if (path.dirname(dbPath) !== auditDirectory) throw new Error('Audit database must remain in the dedicated artifact directory')
if (fs.existsSync(dbPath)) throw new Error('Refuse overwriting an existing audit database; choose a fresh .db name')
const db = DatabaseConnection.initialize(dbPath)
const queries = new QueryBuilder(db.getDb())

try {
  const extraction = new ExtractionOrchestrator(root, queries)
  const indexed = await extraction.indexAll()
  const resolver = createResolver(root, queries)
  resolver.runPostExtract()
  const resolution = await resolver.resolveAndPersistBatched()
  const files = db.getDb().prepare('select path,size,node_count from files').all()
  console.log(JSON.stringify({
    version: '1.5.0',
    mode: 'installed programmatic extraction/resolution API; original index untouched',
    root,
    dbPath,
    config: JSON.parse(fs.readFileSync('codegraph.json', 'utf8')),
    indexed,
    resolution,
    stats: queries.getStats(),
    artifactFiles: files.filter(file => file.path.startsWith('artifacts/')).length,
    serverIndexed: files.some(file => file.path === 'apps/api/src/server.ts'),
    dbBytes: db.getSize(),
  }, null, 2))
} finally {
  db.close()
}
