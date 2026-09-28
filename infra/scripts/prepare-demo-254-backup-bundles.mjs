#!/usr/bin/env node
// Offline packaging only. Every source byte comes from one exact main commit.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const files = [
  'infra/protected/attest-demo-254-frozen-plan.mjs',
  'infra/protected/attest-demo-254-backup.mjs',
  'infra/protected/attest-postgres-backup.mjs',
  'infra/protected/capture-demo-254-backup.mjs',
  'infra/protected/review-demo-254-backup-source.mjs',
  'infra/protected/consume-production-evidence-nonce.py',
]
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const check = (condition, message) => { if (!condition) throw new Error(message) }
const git = args => execFileSync('/usr/bin/git', ['-C', root, ...args], { maxBuffer: 4 * 1024 * 1024 })

export function packageDemo254Controls({ commit, output, readCommit = (sha, path) => git(['show', `${sha}:${path}`]), bundle = buildSync }) {
  check(/^[a-f0-9]{40}$/u.test(commit), 'full commit SHA required')
  check(output === resolve(output), 'new absolute output path required')
  const stage = mkdtempSync(join(tmpdir(), 'demo-254-control-source-'))
  try {
    const sourceSha256 = {}
    for (const path of files) {
      const bytes = readCommit(commit, path)
      check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length < 2 * 1024 * 1024, `reviewed source missing: ${path}`)
      const target = join(stage, path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, bytes)
      sourceSha256[path] = sha(bytes)
    }
    const built = {}
    for (const [control, entry] of [
      ['demo254Plan', 'attest-demo-254-frozen-plan'],
      ['demo254Backup', 'attest-demo-254-backup'],
    ]) {
      const file = join(stage, 'infra/protected', `${entry}.mjs`)
      const result = bundle({ entryPoints: [file], bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false })
      check(result.outputFiles?.length === 1, 'standalone bundle missing')
      const bytes = Buffer.from(result.outputFiles[0].contents)
      check(bytes.toString('utf8').startsWith('#!/usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node\n'), 'bundle shebang drift')
      built[control] = { file: entry, bytes, sha256: sha(bytes) }
    }
    const nonce = readFileSync(join(stage, 'infra/protected/consume-production-evidence-nonce.py'))
    const manifest = { schema_version: 'demo-254-protected-controls/1', source_commit: commit, source_sha256: sourceSha256,
      plan_bundle_sha256: built.demo254Plan.sha256, backup_bundle_sha256: built.demo254Backup.sha256,
      nonce_consumer_sha256: sha(nonce) }
    mkdirSync(output, { mode: 0o700 })
    for (const value of Object.values(built)) writeFileSync(join(output, value.file), value.bytes, { flag: 'wx', mode: 0o400 })
    writeFileSync(join(output, 'consume-production-evidence-nonce'), nonce, { flag: 'wx', mode: 0o400 })
    writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o400 })
    return { manifest, manifest_sha256: sha(readFileSync(join(output, 'manifest.json'))) }
  } finally { rmSync(stage, { recursive: true, force: true }) }
}

function main(args) {
  check(args.length === 4 && args[0] === '--commit' && args[2] === '--output', 'exact --commit and --output required')
  const commit = args[1], output = args[3]
  check(git(['branch', '--show-current']).toString('utf8').trim() === 'main', 'packaging requires main')
  check(git(['rev-parse', 'refs/heads/main']).toString('utf8').trim() === commit, 'package commit must be exact main HEAD')
  const result = packageDemo254Controls({ commit, output })
  process.stdout.write(`${JSON.stringify({ output, ...result })}\n`)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)) } catch (error) { process.stderr.write(`demo 254 package rejected: ${error.message}\n`); process.exitCode = 1 }
}
