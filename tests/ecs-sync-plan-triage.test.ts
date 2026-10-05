import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { buildTriageReport } from '../infra/scripts/triage-ecs-sync-plan.mjs'

const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ecs-sync-plan-triage-'))
  const bundle = join(root, 'candidate')
  const sourceTree = join(root, 'source-tree')
  mkdirSync(bundle); mkdirSync(sourceTree)
  const candidateFiles: Record<string, string> = {
    'apps/api/src/server.ts': 'export const candidate = true\n',
    'package.json': '{"name":"candidate"}\n',
    '.env.example': 'API_SECRET=placeholder\n',
    'infra/new-candidate-script.mjs': 'export default 1\n',
    'README.md': '# same\n',
  }
  const remoteFiles: Record<string, string> = {
    'apps/api/src/server.ts': 'export const remote = true\n',
    'package.json': '{"name":"remote"}\n',
    '.env.example': 'API_SECRET=remote-placeholder\n',
  }
  for (const [path, text] of Object.entries(candidateFiles)) {
    const full = join(sourceTree, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, text)
  }
  const paths = Object.keys(candidateFiles).sort()
  execFileSync('tar', ['-cf', join(bundle, 'candidate-source.tar'), '-C', sourceTree, ...paths])
  const manifest = Buffer.from(`${paths.join('\n')}\n`)
  const rows = [
    `review_required\t${digest(candidateFiles['apps/api/src/server.ts']!)}\t${digest(remoteFiles['apps/api/src/server.ts']!)}\tapps/api/src/server.ts`,
    `review_required\t${digest(candidateFiles['package.json']!)}\t${digest(remoteFiles['package.json']!)}\tpackage.json`,
    `review_required\t${digest(candidateFiles['.env.example']!)}\t${digest(remoteFiles['.env.example']!)}\t.env.example`,
    `missing_remote\t${digest(candidateFiles['infra/new-candidate-script.mjs']!)}\t-\tinfra/new-candidate-script.mjs`,
    `same\t${digest(candidateFiles['README.md']!)}\t${digest(candidateFiles['README.md']!)}\tREADME.md`,
  ]
  const plan = Buffer.from(`status\tlocal_sha256\tremote_sha256\tpath\n${rows.join('\n')}\n`)
  writeFileSync(join(bundle, 'files.txt'), manifest)
  writeFileSync(join(bundle, 'sync-plan.tsv'), plan)
  const archive = readFileSync(join(bundle, 'candidate-source.tar'))
  const identity = [
    `git_sha=${'a'.repeat(40)}`,
    `source_sha256=sha256:${digest(archive)}`,
    `comparison_manifest_sha256=sha256:${digest(manifest)}`,
    `sync_plan_sha256=sha256:${digest(plan)}`,
  ].join('\n')
  writeFileSync(join(bundle, 'candidate-identity.txt'), identity)

  const reviewSourceDir = join(bundle, 'remote-review-source', 'apps', 'api', 'src')
  mkdirSync(reviewSourceDir, { recursive: true })
  writeFileSync(join(reviewSourceDir, 'server.ts'), remoteFiles['apps/api/src/server.ts']!)
  const reportBinding = {
    candidate_git_sha: 'a'.repeat(40),
    candidate_source_sha256: `sha256:${digest(archive)}`,
    candidate_sync_plan_sha256: `sha256:${digest(plan)}`,
  }
  writeFileSync(join(bundle, 'remote-review-source', 'review-acquisition.json'), JSON.stringify({
    ...reportBinding, remote_read_only: true, fetched_count: 1,
    files: [{ path: 'apps/api/src/server.ts', bytes: remoteFiles['apps/api/src/server.ts']!.length, remote_sha256: digest(remoteFiles['apps/api/src/server.ts']!) }],
    refused_count: 2, refused_paths: ['.env.example', 'package.json'],
  }))
  writeFileSync(join(bundle, 'remote-structure-review.json'), JSON.stringify({
    schema_version: 1, ...reportBinding, remote_alias: '101', remote_root: '/opt/merchant-deploy',
    remote_read_only: true, raw_remote_bytes_persisted: false,
    structural_review_count: 1, protected_onsite_review_count: 1,
    structural_review: [{ path: 'package.json', candidate_sha256: digest(candidateFiles['package.json']!), remote_sha256: digest(remoteFiles['package.json']!), candidate_status: 'reviewed', remote_status: 'reviewed', structure_matches: false, candidate_summary: {}, remote_summary: {} }],
    protected_onsite_review: [{ path: '.env.example', status: 'protected_onsite_review_required', remote_sha256_bound_to_plan: digest(remoteFiles['.env.example']!) }],
  }))
  return { root, bundle }
}

describe('ECS sync-plan triage', () => {
  it('executes the candidate-new confirmation probe and parses its tab-delimited response', () => {
    const value = fixture()
    try {
      const bin = join(value.root, 'bin')
      const remote = join(realpathSync(value.root), 'remote')
      mkdirSync(bin); mkdirSync(remote)
      // Execute the actual generated remote Python through a local SSH stand-in.
      // This catches quoting and serialization errors without contacting a host.
      const ssh = join(bin, 'ssh')
      writeFileSync(ssh, '#!/usr/bin/env python3\nimport os,sys\nos.execvp("sh", ["sh", "-c", sys.argv[-1]])\n')
      chmodSync(ssh, 0o755)
      const output = join(value.root, 'confirmation.json')
      execFileSync(process.execPath, ['infra/scripts/confirm-ecs-candidate-new-files.mjs', value.bundle, output], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ECS_CANDIDATE_REMOTE_ALIAS: '101', ECS_CANDIDATE_REMOTE_ROOT: remote },
      })
      const report = JSON.parse(readFileSync(output, 'utf8'))
      expect(report).toMatchObject({ approved: true, remote_read_only: true, count: 1 })
      expect(report.files).toEqual([{ path: 'infra/new-candidate-script.mjs', local_sha256: digest('export default 1\n'), archive_member: true, archive_sha256: digest('export default 1\n'), remote_state: 'absent' }])
      mkdirSync(join(remote, 'infra'))
      writeFileSync(join(remote, 'infra', 'new-candidate-script.mjs'), 'remote-owned bytes')
      expect(() => execFileSync(process.execPath, ['infra/scripts/confirm-ecs-candidate-new-files.mjs', value.bundle, join(value.root, 'rejected.json')], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ECS_CANDIDATE_REMOTE_ALIAS: '101', ECS_CANDIDATE_REMOTE_ROOT: remote },
        stdio: 'pipe',
      })).toThrow('remote confirmation found an existing, unsafe or malformed path')
      expect(readFileSync(join(remote, 'infra', 'new-candidate-script.mjs'), 'utf8')).toBe('remote-owned bytes')
    } finally { rmSync(value.root, { recursive: true, force: true }) }
  })

  it('partitions review material and emits a fail-closed merge checklist', () => {
    const value = fixture()
    try {
      const report = buildTriageReport(value.bundle)
      expect(report.counts).toEqual({ same: 1, review_required: 3, missing_remote: 1 })
      expect(report.review_required).toMatchObject({
        count: 3,
        source_fetched_count: 1,
        structural_count: 1,
        structural_mismatch_count: 1,
        protected_onsite_count: 1,
        partition_complete: true,
      })
      expect(report.missing_remote.paths).toEqual(['infra/new-candidate-script.mjs'])
      expect(report.decision).toBe('NO_GO')
      expect(report.blockers).toEqual([
        'review_required_three_way_merge_not_approved',
        'protected_onsite_review_not_approved',
        'missing_remote_new_file_confirmation_not_approved',
        'candidate_runtime_evidence_not_present',
      ])
    } finally { rmSync(value.root, { recursive: true, force: true }) }
  })

  it('rejects an unbound report instead of treating it as review evidence', () => {
    const value = fixture()
    try {
      const path = join(value.bundle, 'remote-structure-review.json')
      const report = JSON.parse(readFileSync(path, 'utf8'))
      report.candidate_git_sha = 'b'.repeat(40)
      writeFileSync(path, JSON.stringify(report))
      expect(() => buildTriageReport(value.bundle)).toThrow('remote structure review is not bound to candidate identity')
    } finally { rmSync(value.root, { recursive: true, force: true }) }
  })

  it('accepts an identity-bound read-only confirmation for candidate-new files', () => {
    const value = fixture()
    try {
      const identity = Object.fromEntries(readFileSync(join(value.bundle, 'candidate-identity.txt'), 'utf8').trim().split(/\r?\n/u).map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)] }))
      const localSha = digest('export default 1\n')
      writeFileSync(join(value.bundle, 'candidate-new-file-confirmation.json'), JSON.stringify({
        schema_version: 'ecs-candidate-new-file-confirmation/1',
        candidate_git_sha: identity.git_sha,
        candidate_source_sha256: identity.source_sha256,
        candidate_sync_plan_sha256: identity.sync_plan_sha256,
        candidate_archive_sha256: identity.source_sha256,
        remote_alias: '101', remote_root: '/opt/merchant-deploy', remote_read_only: true, approved: true, count: 1,
        files: [{ path: 'infra/new-candidate-script.mjs', local_sha256: localSha, archive_member: true, archive_sha256: localSha, remote_state: 'absent' }],
      }))
      const report = buildTriageReport(value.bundle)
      expect(report.missing_remote.confirmation).toMatchObject({ required: true, approved: true, count: 1 })
      expect(report.blockers).not.toContain('missing_remote_new_file_confirmation_not_approved')
    } finally { rmSync(value.root, { recursive: true, force: true }) }
  })

  it('records protected onsite structure observations without approving semantic review', () => {
    const value = fixture()
    try {
      const identity = Object.fromEntries(readFileSync(join(value.bundle, 'candidate-identity.txt'), 'utf8').trim().split(/\r?\n/u).map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)] }))
      const remoteSha = digest('API_SECRET=remote-placeholder\n')
      writeFileSync(join(value.bundle, 'protected-onsite-structure-review.json'), JSON.stringify({
        schema_version: 'ecs-protected-onsite-review/1', candidate_git_sha: identity.git_sha, candidate_source_sha256: identity.source_sha256, candidate_sync_plan_sha256: identity.sync_plan_sha256,
        remote_alias: '101', remote_root: '/opt/merchant-deploy', remote_read_only: true, raw_remote_bytes_persisted: false,
        // A legacy hash-only report may claim approval; metadata alone must not
        // satisfy the semantic protected-wiring review gate.
        protected_onsite_review_count: 1, approved: false, review_scope: 'hash_and_metadata_only', semantic_review_completed: false,
        protected_onsite_review: [{ path: '.env.example', remote_sha256_bound_to_plan: remoteSha, remote_sha256_observed: remoteSha, bytes: 31, mode: '0644', uid: 501, gid: 10, digest_match: true, status: 'reviewed_protected_structure' }],
      }))
      const report = buildTriageReport(value.bundle)
      expect(report.protected_onsite).toMatchObject({ required: true, approved: false, count: 1 })
      expect(report.blockers).toContain('protected_onsite_review_not_approved')
      expect(report.protected_onsite.semantic_diff).toMatchObject({ status: 'not_run', reason: 'trusted_remote_identity_unavailable' })
    } finally { rmSync(value.root, { recursive: true, force: true }) }
  })

  it('does not treat the candidate identity or an unverified host marker as a trusted semantic baseline', () => {
    const value = fixture()
    try {
      const identity = Object.fromEntries(readFileSync(join(value.bundle, 'candidate-identity.txt'), 'utf8').trim().split(/\r?\n/u).map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)] }))
      writeFileSync(join(value.bundle, 'protected-onsite-semantic-diff.json'), JSON.stringify({
        schema_version: 'ecs-protected-onsite-semantic-diff/1', candidate_git_sha: identity.git_sha, candidate_source_sha256: identity.source_sha256, candidate_sync_plan_sha256: identity.sync_plan_sha256,
        remote_alias: '101', remote_root: '/opt/merchant-deploy', remote_read_only: true, raw_remote_bytes_persisted: false,
        trusted_remote_baseline: { status: 'unverified', revision: 'candidate-identity-only', manifest_sha256: '0'.repeat(64), attestation_verified: false },
        semantic_review_completed: true, approved: true, files: [],
      }))
      const report = buildTriageReport(value.bundle)
      expect(report.protected_onsite.semantic_diff).toMatchObject({ status: 'not_run', reason: 'trusted_remote_identity_unverified', approved: false })
    } finally { rmSync(value.root, { recursive: true, force: true }) }
  })

  it('records a host base bound for classification without treating it as trusted approval', () => {
    const value = fixture()
    try {
      const identity = Object.fromEntries(readFileSync(join(value.bundle, 'candidate-identity.txt'), 'utf8').trim().split(/\r?\n/u).map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)] }))
      writeFileSync(join(value.bundle, 'protected-onsite-semantic-diff.json'), JSON.stringify({
        schema_version: 'ecs-protected-onsite-semantic-diff/1', candidate_git_sha: identity.git_sha, candidate_source_sha256: identity.source_sha256, candidate_sync_plan_sha256: identity.sync_plan_sha256,
        remote_alias: '101', remote_root: '/opt/merchant-deploy', remote_read_only: true, raw_remote_bytes_persisted: false,
        trusted_remote_baseline: { status: 'classification_only', revision: 'release-85575f9c', manifest_sha256: 'b'.repeat(64), attestation_verified: false },
        semantic_review_completed: false, approved: false, files: [],
      }))
      const report = buildTriageReport(value.bundle)
      expect(report.protected_onsite.semantic_diff).toMatchObject({ status: 'classification_only', reason: 'trusted_remote_identity_bound_for_classification_only', approved: false })
    } finally { rmSync(value.root, { recursive: true, force: true }) }
  })

  it('consumes a complete semantic diff only with a verified trusted host baseline', () => {
    const value = fixture()
    try {
      const identity = Object.fromEntries(readFileSync(join(value.bundle, 'candidate-identity.txt'), 'utf8').trim().split(/\r?\n/u).map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)] }))
      const candidateSha = digest('API_SECRET=placeholder\n')
      const remoteSha = digest('API_SECRET=remote-placeholder\n')
      writeFileSync(join(value.bundle, 'protected-onsite-structure-review.json'), JSON.stringify({
        schema_version: 'ecs-protected-onsite-review/1', candidate_git_sha: identity.git_sha, candidate_source_sha256: identity.source_sha256, candidate_sync_plan_sha256: identity.sync_plan_sha256,
        remote_alias: '101', remote_root: '/opt/merchant-deploy', remote_read_only: true, raw_remote_bytes_persisted: false,
        protected_onsite_review_count: 1, approved: false, review_scope: 'hash_and_metadata_only', semantic_review_completed: false,
        protected_onsite_review: [{ path: '.env.example', remote_sha256_bound_to_plan: remoteSha, remote_sha256_observed: remoteSha, bytes: 31, mode: '0644', uid: 501, gid: 10, digest_match: true, status: 'reviewed_protected_structure' }],
      }))
      writeFileSync(join(value.bundle, 'protected-onsite-semantic-diff.json'), JSON.stringify({
        schema_version: 'ecs-protected-onsite-semantic-diff/1', candidate_git_sha: identity.git_sha, candidate_source_sha256: identity.source_sha256, candidate_sync_plan_sha256: identity.sync_plan_sha256,
        remote_alias: '101', remote_root: '/opt/merchant-deploy', remote_read_only: true, raw_remote_bytes_persisted: false,
        trusted_remote_baseline: { status: 'verified', revision: '101:/opt/merchant-deploy@release-1', manifest_sha256: 'a'.repeat(64), attestation_verified: true },
        semantic_review_completed: true, approved: true,
        files: [{ path: '.env.example', candidate_sha256: candidateSha, remote_sha256: remoteSha, decision: 'approved', semantic_diff_status: 'completed' }],
      }))
      const report = buildTriageReport(value.bundle)
      expect(report.protected_onsite.semantic_diff).toMatchObject({ status: 'completed', approved: true, count: 1 })
      expect(report.protected_onsite).toMatchObject({ approved: true, count: 1 })
    } finally { rmSync(value.root, { recursive: true, force: true }) }
  })

  it('rejects a protected report that omits explicit hash-only evidence fields', () => {
    const value = fixture()
    try {
      const identity = Object.fromEntries(readFileSync(join(value.bundle, 'candidate-identity.txt'), 'utf8').trim().split(/\r?\n/u).map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)] }))
      const remoteSha = digest('API_SECRET=remote-placeholder\n')
      writeFileSync(join(value.bundle, 'protected-onsite-structure-review.json'), JSON.stringify({
        schema_version: 'ecs-protected-onsite-review/1', candidate_git_sha: identity.git_sha, candidate_source_sha256: identity.source_sha256, candidate_sync_plan_sha256: identity.sync_plan_sha256,
        remote_alias: '101', remote_root: '/opt/merchant-deploy', remote_read_only: true, raw_remote_bytes_persisted: false,
        protected_onsite_review_count: 1, approved: true, semantic_review_completed: false,
        protected_onsite_review: [{ path: '.env.example', remote_sha256_bound_to_plan: remoteSha, status: 'approved_protected_structure' }],
      }))
      expect(() => buildTriageReport(value.bundle)).toThrow('explicitly unapproved hash-only report')
    } finally { rmSync(value.root, { recursive: true, force: true }) }
  })

  it('rejects duplicate candidate identity keys instead of silently overwriting them', () => {
    const value = fixture()
    try {
      const identityPath = join(value.bundle, 'candidate-identity.txt')
      const identity = readFileSync(identityPath, 'utf8')
      writeFileSync(identityPath, `${identity}\ngit_sha=${'b'.repeat(40)}\n`)
      expect(() => buildTriageReport(value.bundle)).toThrow('candidate identity has duplicate key: git_sha')
    } finally { rmSync(value.root, { recursive: true, force: true }) }
  })
})
