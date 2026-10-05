#!/usr/bin/env node
// Read-only confirmation that sync-plan missing_remote paths are new candidate files.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const fail = message => { console.error(message); process.exit(2) }
const [bundleArg, outputArg] = process.argv.slice(2)
if (!bundleArg || process.argv.length !== 4) fail('usage: node infra/scripts/confirm-ecs-candidate-new-files.mjs <candidate-bundle-dir> <output-json>')
const bundle = resolve(bundleArg), output = resolve(outputArg)
const alias = process.env.ECS_CANDIDATE_REMOTE_ALIAS ?? '101'
const remoteRoot = process.env.ECS_CANDIDATE_REMOTE_ROOT ?? '/opt/merchant-deploy'
if (!/^[A-Za-z0-9][A-Za-z0-9._@-]*$/u.test(alias)) fail('unsafe SSH alias')
if (!/^\/[A-Za-z0-9._/-]+$/u.test(remoteRoot) || remoteRoot.includes('..') || remoteRoot.includes('//')) fail('unsafe remote root')
const regular = path => { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) fail(`candidate input is not a regular file: ${path}`); return readFileSync(path) }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const identityLines = regular(join(bundle, 'candidate-identity.txt')).toString().trim().split(/\r?\n/u)
const identity = {}
for (const line of identityLines) {
  const i = line.indexOf('=')
  if (i < 1 || line.indexOf('=', i + 1) !== -1) fail('candidate identity is malformed')
  const key = line.slice(0, i), value = line.slice(i + 1)
  if (identity[key] !== undefined) fail(`candidate identity has duplicate key: ${key}`)
  identity[key] = value
}
if (!/^[0-9a-f]{40}$/u.test(identity.git_sha ?? '')
  || !/^sha256:[0-9a-f]{64}$/u.test(identity.source_sha256 ?? '')
  || !/^sha256:[0-9a-f]{64}$/u.test(identity.sync_plan_sha256 ?? '')) fail('candidate identity is incomplete')
const plan = regular(join(bundle, 'sync-plan.tsv')).toString().trimEnd().split(/\r?\n/u)
if (plan.shift() !== 'status\tlocal_sha256\tremote_sha256\tpath') fail('unrecognized sync-plan format')
const planBytes = regular(join(bundle, 'sync-plan.tsv'))
if (identity.sync_plan_sha256 !== `sha256:${digest(planBytes)}`) fail('candidate identity does not bind sync-plan.tsv')
const rows = plan.map(line => {
  const columns = line.split('\t')
  if (columns.length !== 4 || columns.some(column => !column)) fail('sync-plan row has invalid column count or empty field')
  const [status, localSha, remoteSha, path] = columns
  if (!['same', 'review_required', 'missing_remote'].includes(status) || !/^[0-9a-f]{64}$/u.test(localSha)) fail(`invalid sync-plan row for ${path}`)
  if (status === 'missing_remote' ? remoteSha !== '-' : !/^[0-9a-f]{64}$/u.test(remoteSha)) fail(`invalid remote digest in sync-plan for ${path}`)
  return { status, local_sha256: localSha, path }
})
const missing = rows.filter(row => row.status === 'missing_remote').map(({ path, local_sha256 }) => ({ path, local_sha256 }))
if (!missing.length) fail('candidate has no missing_remote paths')
if (new Set(rows.map(row => row.path)).size !== rows.length) fail('sync-plan contains duplicate paths')
for (const item of missing) if (!/^[A-Za-z0-9._/-]+$/u.test(item.path) || item.path.startsWith('/') || item.path.split('/').some(part => part === '..' || part === '.' || part === '')) fail(`unsafe missing_remote path: ${item.path}`)
const archive = join(bundle, 'candidate-source.tar')
const archiveBytes = regular(archive)
if (identity.source_sha256 !== `sha256:${digest(archiveBytes)}`) fail('candidate identity does not bind source archive')
const archiveInventory = JSON.parse(execFileSync('python3', ['-c', `import hashlib,json,pathlib,sys,tarfile
max_members, max_file, max_total = 250000, 2 * 1024 * 1024 * 1024, 4 * 1024 * 1024 * 1024
seen, total, result = set(), 0, []
with tarfile.open(sys.argv[1], "r:") as archive:
    members = archive.getmembers()
    if not members or len(members) > max_members: raise SystemExit('invalid candidate archive member count')
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or not member.name or '..' in path.parts or '\\n' in member.name or '\\r' in member.name:
            raise SystemExit('unsafe candidate archive member path')
        normalized = path.as_posix().rstrip('/')
        if not normalized or normalized in seen: raise SystemExit('duplicate candidate archive path')
        seen.add(normalized)
        if not (member.isdir() or member.isfile()): raise SystemExit('candidate archive contains a link or special file')
        if member.mode & 0o7000: raise SystemExit('candidate archive contains privileged mode bits')
        if member.isfile():
            if member.size > max_file: raise SystemExit('candidate archive member is too large')
            total += member.size
            if total > max_total: raise SystemExit('candidate archive expands beyond release limit')
            content = archive.extractfile(member).read()
            result.append({"path":member.name,"regular":True,"sha256":hashlib.sha256(content).hexdigest()})
        else:
            result.append({"path":member.name,"regular":False,"sha256":None})
print(json.dumps(result))`, archive], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }))
if (new Set(archiveInventory.map(item => item.path)).size !== archiveInventory.length) fail('candidate archive contains duplicate members')
const archiveMembers = new Map(archiveInventory.map(item => [item.path, item]))
for (const item of missing) {
  const member = archiveMembers.get(item.path)
  if (!member?.regular || member.sha256 !== item.local_sha256) fail(`candidate-new archive member digest or type mismatch: ${item.path}`)
}
const remoteInput = JSON.stringify({ root: remoteRoot, paths: missing.map(item => item.path) })
const remoteProgram = `import json,os,stat,sys
request=json.load(sys.stdin)
root=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
try:
    for part in request['root'].split('/')[1:]:
        child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=root)
        os.close(root)
        root=child
    for path in request['paths']:
        parent=os.dup(root)
        state='absent'
        try:
            parts=path.split('/')
            for part in parts[:-1]:
                child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
                os.close(parent)
                parent=child
            os.stat(parts[-1],dir_fd=parent,follow_symlinks=False)
            state='present'
        except FileNotFoundError:
            pass
        except OSError:
            state='unreadable_or_unsafe_parent'
        finally:
            os.close(parent)
        print(state+'\\t'+path)
finally:
    os.close(root)`
const shell = `python3 -c '${remoteProgram.replaceAll("'", "'\\''")}'`
const remote = execFileSync('ssh', ['-o', 'BatchMode=yes', alias, shell], { input: remoteInput, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 120_000 })
const responseLines = remote.trimEnd().split(/\r?\n/u).filter(Boolean)
const states = new Map(responseLines.map(line => { const i = line.indexOf('\t'); return [line.slice(i + 1), line.slice(0, i)] }))
if (responseLines.length !== missing.length || states.size !== missing.length || missing.some(item => states.get(item.path) !== 'absent')) fail('remote confirmation found an existing, unsafe or malformed path')
const report = { schema_version: 'ecs-candidate-new-file-confirmation/1', candidate_git_sha: identity.git_sha, candidate_source_sha256: identity.source_sha256, candidate_sync_plan_sha256: identity.sync_plan_sha256, candidate_archive_sha256: identity.source_sha256, observed_at: new Date().toISOString(), remote_alias: alias, remote_root: remoteRoot, remote_read_only: true, approved: true, count: missing.length, files: missing.map(item => ({ ...item, archive_member: true, archive_sha256: item.local_sha256, remote_state: 'absent' })) }
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
console.log(`Confirmed ${missing.length} candidate-new files: archive-bound and absent on ${alias}:${remoteRoot}`)
