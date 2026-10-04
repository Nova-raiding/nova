import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
})
