#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, createReadStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync, lstatSync, renameSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isAllowlistedReviewSource } from './ecs-review-source-policy.mjs'

const fail = (message) => { console.error(message); process.exit(2) }
const args = process.argv.slice(2)
if (args.length < 1 || args.length > 2) fail('usage: node infra/scripts/acquire-ecs-review-source.mjs <candidate-bundle-dir> [output-dir]')
const bundle = resolve(args[0])
const output = resolve(args[1] ?? join(bundle, 'remote-review-source'))
const alias = process.env.ECS_CANDIDATE_REMOTE_ALIAS ?? '101'
const remoteRoot = process.env.ECS_CANDIDATE_REMOTE_ROOT ?? '/opt/merchant-deploy'
if (!/^[A-Za-z0-9][A-Za-z0-9._@-]*$/u.test(alias)) fail('unsafe SSH alias')
if (!/^\/[A-Za-z0-9._/-]+$/u.test(remoteRoot) || remoteRoot.includes('..') || remoteRoot.includes('//')) fail('unsafe remote root')
if (!isAbsolute(output) || dirname(output) !== bundle || output === bundle) fail('output-dir must be a new direct child of the candidate bundle')

const sha = (data) => createHash('sha256').update(data).digest('hex')
const shaFile = async (path) => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
const readRegular = (path) => {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`candidate input is not a regular file: ${path}`)
  return readFileSync(path)
}
const identity = Object.fromEntries(readRegular(join(bundle, 'candidate-identity.txt')).toString('utf8').trim().split(/\r?\n/u).map((line) => {
  const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]
}))
const archive = join(bundle, 'candidate-source.tar')
const archiveStat = lstatSync(archive)
if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || !/^[0-9a-f]{40}$/u.test(identity.git_sha ?? '') || identity.source_sha256 !== `sha256:${await shaFile(archive)}`) fail('candidate identity does not bind the regular source archive')
const manifestBytes = readRegular(join(bundle, 'files.txt'))
const planBytes = readRegular(join(bundle, 'sync-plan.tsv'))
if (identity.comparison_manifest_sha256 !== `sha256:${sha(manifestBytes)}` || identity.sync_plan_sha256 !== `sha256:${sha(planBytes)}`) fail('candidate identity does not bind files.txt and sync-plan.tsv')

const manifest = manifestBytes.toString('utf8').split(/\r?\n/u).filter(Boolean)
const manifestSet = new Set(manifest)
if (manifestSet.size !== manifest.length) fail('candidate file manifest contains duplicate paths')
const rows = planBytes.toString('utf8').trimEnd().split(/\r?\n/u)
if (rows.shift() !== 'status\tlocal_sha256\tremote_sha256\tpath') fail('unrecognized sync-plan format')
const planByPath = new Map()
for (const line of rows) {
  const columns = line.split('\t')
  if (columns.length !== 4 || columns.some((column) => !column)) fail('sync-plan row has invalid column count or empty field')
  const [status, localSha, remoteSha, path] = columns
  if (!['same', 'review_required', 'missing_remote'].includes(status) || !/^[0-9a-f]{64}$/u.test(localSha)) fail(`invalid sync-plan row for ${path}`)
  if (status === 'missing_remote' ? remoteSha !== '-' : !/^[0-9a-f]{64}$/u.test(remoteSha)) fail(`invalid remote digest in sync-plan row for ${path}`)
  if (status === 'same' && localSha !== remoteSha || status === 'review_required' && localSha === remoteSha) fail(`sync-plan status does not match digests for ${path}`)
  if (planByPath.has(path)) fail(`duplicate sync-plan path: ${path}`)
  if (!manifestSet.has(path)) fail(`sync plan references path outside the bound manifest: ${path}`)
  planByPath.set(path, { status, remoteSha })
}
const review = [...planByPath].filter(([, value]) => value.status === 'review_required').map(([path]) => path)
const eligible = review.filter(isAllowlistedReviewSource)
const refused = review.filter((path) => !isAllowlistedReviewSource(path))
if (!eligible.length) fail('no review_required source files pass the source-only allowlist')
if (lstatExists(output)) fail('output directory already exists; refusing overwrite')

const python = String.raw`import hashlib,json,os,stat,sys
root=sys.argv[1]
paths=[line.rstrip('\n') for line in sys.stdin]
def open_beneath(path):
    parts=path.split('/')
    fd=os.open(root, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            nxt=os.open(part, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd=nxt
        f=os.open(parts[-1], os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK, dir_fd=fd)
    finally:
        os.close(fd)
    if not stat.S_ISREG(os.fstat(f).st_mode):
        os.close(f); raise RuntimeError('remote path is not a regular file: '+path)
    return f
for path in paths:
    fd=open_beneath(path)
    try:
        data=b''
        while True:
            block=os.read(fd, 1024*1024)
            if not block: break
            data+=block
            if len(data)>8*1024*1024: raise RuntimeError('remote source file exceeds 8 MiB: '+path)
        header=json.dumps({'path':path,'size':len(data),'sha256':hashlib.sha256(data).hexdigest()},separators=(',',':')).encode()+b'\n'
        sys.stdout.buffer.write(header); sys.stdout.buffer.write(data); sys.stdout.buffer.flush()
    finally:
        os.close(fd)`
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`
const command = `cd -- ${shellQuote(remoteRoot)} && python3 -c ${shellQuote(python)} ${shellQuote(remoteRoot)}`
const transfer = spawnSync('ssh', ['-o', 'BatchMode=yes', alias, command], { input: Buffer.from(`${eligible.join('\n')}\n`), maxBuffer: 256 * 1024 * 1024, timeout: 120_000 })
if (transfer.error) fail(`SSH source acquisition failed: ${transfer.error.message}`)
if (transfer.status !== 0) fail(`remote source acquisition rejected or failed (exit ${transfer.status}); stderr suppressed to avoid leaking host data`)
const payload = transfer.stdout
let offset = 0
const records = []
for (const expected of eligible) {
  const newline = payload.indexOf(0x0a, offset)
  if (newline < 0) fail('truncated remote file header')
  let header
  try { header = JSON.parse(payload.subarray(offset, newline).toString('utf8')) } catch { fail('invalid remote file header') }
  offset = newline + 1
  if (header.path !== expected || !Number.isSafeInteger(header.size) || header.size < 0 || header.size > 8 * 1024 * 1024 || !/^[0-9a-f]{64}$/u.test(header.sha256)) fail(`unexpected remote file record: ${expected}`)
  const data = payload.subarray(offset, offset + header.size)
  if (data.length !== header.size || sha(data) !== header.sha256) fail(`remote transfer digest mismatch: ${expected}`)
  if (header.sha256 !== planByPath.get(expected).remoteSha) fail(`remote file no longer matches reviewed sync-plan digest: ${expected}`)
  offset += header.size
  records.push({ path: expected, data, bytes: header.size, remote_sha256: header.sha256 })
}
if (offset !== payload.length) fail('unexpected trailing bytes in remote transfer')
const report = { candidate_git_sha: identity.git_sha, candidate_source_sha256: identity.source_sha256, candidate_sync_plan_sha256: identity.sync_plan_sha256, remote_alias: alias, remote_root: remoteRoot, remote_read_only: true, fetched_count: records.length, refused_count: refused.length, refused_paths: refused, files: records.map(({ data, ...record }) => record) }
const stage = mkdtempSync(join(bundle, '.remote-review-source-staging-'))
chmodSync(stage, 0o700)
try {
  for (const record of records) {
    const destination = join(stage, record.path)
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    writeFileSync(destination, record.data, { flag: 'wx', mode: 0o600 })
  }
  writeFileSync(join(stage, 'review-acquisition.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  renameSync(stage, output)
} catch (error) {
  rmSync(stage, { recursive: true, force: true })
  fail(`could not atomically publish review acquisition: ${error.message}`)
}
console.log(`Fetched ${records.length} allowlisted source files into ${output}; refused ${refused.length} non-source/config paths.`)
console.log('No remote files were written or modified. Review with diff -ru against the candidate tree; this output is not a merge.')

function lstatExists(path) { try { lstatSync(path); return true } catch (error) { if (error?.code === 'ENOENT') return false; throw error } }
