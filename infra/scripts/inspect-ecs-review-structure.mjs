#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isAllowlistedReviewSource } from './ecs-review-source-policy.mjs'
import { PROTECTED_OPS_PATHS, STRUCTURE_REVIEW_PATHS, summarizeReviewBytes } from './ecs-review-structure.mjs'

const fail = message => { console.error(message); process.exit(2) }
const args = process.argv.slice(2)
if (args.length < 1 || args.length > 2) fail('usage: node infra/scripts/inspect-ecs-review-structure.mjs <candidate-bundle-dir> [report-path]')
const bundle = resolve(args[0])
const output = resolve(args[1] ?? join(bundle, 'remote-structure-review.json'))
const alias = process.env.ECS_CANDIDATE_REMOTE_ALIAS ?? '101'
const remoteRoot = process.env.ECS_CANDIDATE_REMOTE_ROOT ?? '/opt/merchant-deploy'
if (!/^[A-Za-z0-9][A-Za-z0-9._@-]*$/u.test(alias)) fail('unsafe SSH alias')
if (!/^\/[A-Za-z0-9._/-]+$/u.test(remoteRoot) || remoteRoot.includes('..') || remoteRoot.includes('//')) fail('unsafe remote root')
if (!isAbsolute(output) || dirname(output) !== bundle || output === bundle) fail('report path must be a direct child of the candidate bundle')

const sha = data => createHash('sha256').update(data).digest('hex')
const readRegular = path => {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`candidate input is not a regular file: ${path}`)
  return readFileSync(path)
}
const parseIdentity = bytes => Object.fromEntries(bytes.toString('utf8').trim().split(/\r?\n/u).map(line => {
  const index = line.indexOf('=')
  if (index < 1) fail('candidate identity is malformed')
  return [line.slice(0, index), line.slice(index + 1)]
}))
const identity = parseIdentity(readRegular(join(bundle, 'candidate-identity.txt')))
const archivePath = join(bundle, 'candidate-source.tar')
if (!/^[0-9a-f]{40}$/u.test(identity.git_sha ?? '') || identity.source_sha256 !== `sha256:${sha(readRegular(archivePath))}`) fail('candidate identity does not bind the regular source archive')
const manifestBytes = readRegular(join(bundle, 'files.txt'))
const planBytes = readRegular(join(bundle, 'sync-plan.tsv'))
if (identity.comparison_manifest_sha256 !== `sha256:${sha(manifestBytes)}` || identity.sync_plan_sha256 !== `sha256:${sha(planBytes)}`) fail('candidate identity does not bind files.txt and sync-plan.tsv')

const manifest = manifestBytes.toString('utf8').split(/\r?\n/u).filter(Boolean)
const manifestSet = new Set(manifest)
if (manifestSet.size !== manifest.length) fail('candidate file manifest contains duplicate paths')
const planLines = planBytes.toString('utf8').trimEnd().split(/\r?\n/u)
if (planLines.shift() !== 'status\tlocal_sha256\tremote_sha256\tpath') fail('unrecognized sync-plan format')
const planByPath = new Map()
for (const line of planLines) {
  const columns = line.split('\t')
  if (columns.length !== 4 || columns.some(column => !column)) fail('sync-plan row has invalid column count or empty field')
  const [status, localSha, remoteSha, path] = columns
  if (!['same', 'review_required', 'missing_remote'].includes(status) || !/^[0-9a-f]{64}$/u.test(localSha)) fail(`invalid sync-plan row for ${path}`)
  if (status === 'missing_remote' ? remoteSha !== '-' : !/^[0-9a-f]{64}$/u.test(remoteSha)) fail(`invalid remote digest in sync-plan row for ${path}`)
  if (status === 'same' && localSha !== remoteSha || status === 'review_required' && localSha === remoteSha) fail(`sync-plan status does not match digests for ${path}`)
  if (planByPath.has(path) || !manifestSet.has(path)) fail(`duplicate or unbound sync-plan path: ${path}`)
  planByPath.set(path, { status, localSha, remoteSha })
}

const structureSet = new Set(STRUCTURE_REVIEW_PATHS)
const protectedSet = new Set(PROTECTED_OPS_PATHS)
if (structureSet.size !== STRUCTURE_REVIEW_PATHS.length || protectedSet.size !== PROTECTED_OPS_PATHS.length || [...structureSet].some(path => protectedSet.has(path))) fail('review path classification has duplicates')
const rejectedReview = [...planByPath].filter(([path, value]) => value.status === 'review_required' && !isAllowlistedReviewSource(path))
const unclassified = rejectedReview.filter(([path]) => !structureSet.has(path) && !protectedSet.has(path))
if (unclassified.length) fail('review-required paths include unclassified non-source inputs')
const structural = rejectedReview.filter(([path]) => structureSet.has(path))
const protectedPaths = rejectedReview.filter(([path]) => protectedSet.has(path))
if (lstatExists(output)) fail('report already exists; refusing overwrite')

const remoteReader = String.raw`import hashlib,json,os,stat,sys
root=sys.argv[1]
paths=[line.rstrip('\n') for line in sys.stdin]
def open_beneath(path):
    parts=path.split('/')
    if not parts or any(not p or p in ('.','..') for p in parts): raise RuntimeError('unsafe path')
    fd=os.open(root, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            nxt=os.open(part, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd=nxt
        f=os.open(parts[-1], os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK, dir_fd=fd)
    finally:
        os.close(fd)
    if not stat.S_ISREG(os.fstat(f).st_mode):
        os.close(f); raise RuntimeError('non-regular')
    return f
for path in paths:
    fd=open_beneath(path)
    try:
        data=bytearray()
        while True:
            block=os.read(fd, 1024*1024)
            if not block: break
            data.extend(block)
            if len(data)>8*1024*1024: raise RuntimeError('oversized')
        header=json.dumps({'path':path,'size':len(data),'sha256':hashlib.sha256(data).hexdigest()},separators=(',',':')).encode()+b'\n'
        sys.stdout.buffer.write(header); sys.stdout.buffer.write(data); sys.stdout.buffer.flush()
    finally:
        os.close(fd)`
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`
const command = `cd -- ${shellQuote(remoteRoot)} && python3 -c ${shellQuote(remoteReader)} ${shellQuote(remoteRoot)}`
const transfer = structural.length
  ? spawnSync('ssh', ['-o', 'BatchMode=yes', alias, command], { input: Buffer.from(`${structural.map(([path]) => path).join('\n')}\n`), maxBuffer: 256 * 1024 * 1024, timeout: 120_000 })
  : { status: 0, stdout: Buffer.alloc(0) }
if (transfer.error || transfer.status !== 0) fail('remote structural acquisition failed or was refused; remote stderr suppressed')

const acquired = []
let offset = 0
const payload = transfer.stdout
for (const [expected, plan] of structural) {
  const newline = payload.indexOf(0x0a, offset)
  if (newline < 0) fail('truncated remote file header')
  let header
  try { header = JSON.parse(payload.subarray(offset, newline).toString('utf8')) } catch { fail('invalid remote file header') }
  offset = newline + 1
  if (header.path !== expected || !Number.isSafeInteger(header.size) || header.size <= 0 || header.size > 8 * 1024 * 1024 || !/^[0-9a-f]{64}$/u.test(header.sha256)) fail('invalid remote file record')
  const bytes = payload.subarray(offset, offset + header.size)
  if (bytes.length !== header.size || sha(bytes) !== header.sha256) fail('remote structural transfer digest mismatch')
  if (header.sha256 !== plan.remoteSha) fail(`remote bytes differ from bound sync-plan: ${expected}`)
  offset += header.size
  const candidateFile = spawnSync('tar', ['-xOf', archivePath, expected], { maxBuffer: 8 * 1024 * 1024, timeout: 30_000 })
  if (candidateFile.error || candidateFile.status !== 0 || sha(candidateFile.stdout) !== plan.localSha) fail(`candidate archive bytes do not match bound sync-plan: ${expected}`)
  const candidateSummary = summarizeReviewBytes(expected, candidateFile.stdout)
  const remoteSummary = summarizeReviewBytes(expected, bytes)
  acquired.push({
    path: expected,
    candidate_sha256: plan.localSha,
    remote_sha256: plan.remoteSha,
    candidate_status: candidateSummary.status,
    remote_status: remoteSummary.status,
    structure_matches: candidateSummary.status === 'reviewed' && remoteSummary.status === 'reviewed' && JSON.stringify(candidateSummary.summary) === JSON.stringify(remoteSummary.summary),
    candidate_summary: candidateSummary.summary ?? { reason_code: candidateSummary.reason_code },
    remote_summary: remoteSummary.summary ?? { reason_code: remoteSummary.reason_code },
  })
}
if (offset !== payload.length) fail('unexpected trailing bytes in remote structural transfer')

const report = {
  schema_version: 1,
  candidate_git_sha: identity.git_sha,
  candidate_source_sha256: identity.source_sha256,
  candidate_sync_plan_sha256: identity.sync_plan_sha256,
  remote_alias: alias,
  remote_root: remoteRoot,
  remote_read_only: true,
  raw_remote_bytes_persisted: false,
  structural_review_count: acquired.length,
  protected_onsite_review_count: protectedPaths.length,
  structural_review: acquired,
  protected_onsite_review: protectedPaths.map(([path, row]) => ({ path, status: 'protected_onsite_review_required', remote_sha256_bound_to_plan: row.remoteSha })),
}
const stage = mkdtempSync(join(bundle, '.remote-structure-review-staging-'))
chmodSync(stage, 0o700)
try {
  writeFileSync(join(stage, 'remote-structure-review.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  renameSync(join(stage, 'remote-structure-review.json'), output)
  rmSync(stage, { recursive: true, force: true })
} catch {
  rmSync(stage, { recursive: true, force: true })
  fail('could not atomically publish sanitized structural report')
}
console.log(`Published sanitized structure review for ${acquired.length} paths; ${protectedPaths.length} remain for protected onsite review.`)

function lstatExists(path) { try { lstatSync(path); return true } catch (error) { if (error?.code === 'ENOENT') return false; throw error } }
