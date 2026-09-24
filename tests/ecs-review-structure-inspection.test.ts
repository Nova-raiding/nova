import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROTECTED_OPS_PATHS, STRUCTURE_REVIEW_PATHS, summarizeReviewBytes } from '../infra/scripts/ecs-review-structure.mjs'

const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const helper = resolve('infra/scripts/inspect-ecs-review-structure.mjs')

function fixture(overrides: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ecs-review-structure-'))
  const bundle = join(root, 'candidate')
  const bin = join(root, 'bin')
  mkdirSync(bundle); mkdirSync(bin)
  const files: Record<string, string> = {
    'apps/ops-console/src/styles.css': '.card { color: var(--ui); background-image: url("SENTINEL_CSS_VALUE"); }\n',
    'infra/docker/api.Dockerfile': 'FROM node:24 AS build\nARG API_PRIVATE_TOKEN=SENTINEL_DOCKER_VALUE\nRUN npm run build\nCOPY . /app\n',
    '.env.example': 'API_SECRET=SENTINEL_PROTECTED_VALUE\n',
    ...overrides,
  }
  const candidateFiles: Record<string, string> = {
    ...files,
    'apps/ops-console/src/styles.css': '.card { color: var(--candidate); background-image: url("SENTINEL_CANDIDATE_CSS"); }\n',
    'infra/docker/api.Dockerfile': 'FROM node:23 AS build\nARG API_PRIVATE_TOKEN=SENTINEL_CANDIDATE_DOCKER\nRUN npm run build\nCOPY . /app\n',
    '.env.example': 'API_SECRET=SENTINEL_CANDIDATE_PROTECTED_VALUE\n',
  }
  const selected = Object.keys(files)
  const manifest = Buffer.from(`${selected.join('\n')}\n`)
  const rows = selected.map(path => {
    const remote = files[path]!
    return `review_required\t${digest(candidateFiles[path]!)}\t${digest(remote)}\t${path}`
  })
  const plan = Buffer.from(`status\tlocal_sha256\tremote_sha256\tpath\n${rows.join('\n')}\n`)
  const sourceTree = join(root, 'source-tree')
  mkdirSync(sourceTree)
  for (const [path, text] of Object.entries(candidateFiles)) {
    const fullPath = join(sourceTree, path)
    mkdirSync(join(fullPath, '..'), { recursive: true })
    writeFileSync(fullPath, text)
  }
  const archivePath = join(bundle, 'candidate-source.tar')
  execFileSync('tar', ['-cf', archivePath, '-C', sourceTree, ...selected])
  const archive = readFileSync(archivePath)
  writeFileSync(join(bundle, 'files.txt'), manifest)
  writeFileSync(join(bundle, 'sync-plan.tsv'), plan)
  writeFileSync(join(bundle, 'candidate-identity.txt'), [
    `git_sha=${'a'.repeat(40)}`,
    `source_sha256=sha256:${digest(archive)}`,
    `comparison_manifest_sha256=sha256:${digest(manifest)}`,
    `sync_plan_sha256=sha256:${digest(plan)}`,
  ].join('\n'))
  const ssh = join(bin, 'ssh')
  writeFileSync(ssh, `#!/usr/bin/env node
const crypto=require('node:crypto');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{const files=JSON.parse(process.env.FAKE_STRUCTURE_FILES);for(const path of input.trimEnd().split('\\n')){const data=Buffer.from(files[path]??'');process.stdout.write(JSON.stringify({path,size:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')})+'\\n');process.stdout.write(data)}})
`)
  chmodSync(ssh, 0o700)
  const run = (remoteFiles: Record<string, string> = files) => spawnSync(process.execPath, [helper, bundle], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_STRUCTURE_FILES: JSON.stringify(remoteFiles) },
  })
  return { root, bundle, files, run }
}

describe('ECS sanitized remote structure review', () => {
  it('includes candidate port preflight code and regression coverage in protected source review', () => {
    expect(PROTECTED_OPS_PATHS).toContain('infra/scripts/ecs-compose-published-ports.mjs')
    expect(PROTECTED_OPS_PATHS).toContain('infra/scripts/ecs-compose-published-ports.d.mts')
    expect(STRUCTURE_REVIEW_PATHS).toContain('tests/ecs-compose-published-ports.test.ts')
  })

  it('publishes only redacted structural summaries after exact sync-plan hash verification', () => {
    const value = fixture()
    try {
      const result = value.run()
      expect(result.status, result.stderr).toBe(0)
      const reportPath = join(value.bundle, 'remote-structure-review.json')
      const reportText = readFileSync(reportPath, 'utf8')
      const report = JSON.parse(reportText)
      expect(report.structural_review_count).toBe(2)
      expect(report.protected_onsite_review_count).toBe(1)
      expect(report.structural_review.map((item: { path: string }) => item.path)).toEqual([
        'apps/ops-console/src/styles.css', 'infra/docker/api.Dockerfile',
      ])
      expect(report.structural_review[0]).toMatchObject({
        remote_sha256: digest(value.files['apps/ops-console/src/styles.css']!), structure_matches: true,
        candidate_summary: { kind: 'css_structure', property_names: ['background-image', 'color'], selector_count: 1 },
      })
      expect(report.structural_review[1]).toMatchObject({
        structure_matches: true,
        remote_summary: { kind: 'dockerfile_structure', stage_count: 1, instruction_counts: { ARG: 1, COPY: 1, FROM: 1, RUN: 1 } },
      })
      expect(report.protected_onsite_review[0]).toMatchObject({ path: '.env.example', status: 'protected_onsite_review_required' })
      for (const marker of ['SENTINEL_CSS_VALUE', 'SENTINEL_DOCKER_VALUE', 'SENTINEL_PROTECTED_VALUE', 'SENTINEL_CANDIDATE_CSS', 'SENTINEL_CANDIDATE_DOCKER', 'API_PRIVATE_TOKEN']) {
        expect(reportText).not.toContain(marker)
        expect(result.stdout).not.toContain(marker)
        expect(result.stderr).not.toContain(marker)
      }
    } finally { rmSync(value.root, { recursive: true, force: true }) }
  })

  it('rejects byte drift against the reviewed sync plan without publishing report output', () => {
    const value = fixture()
    try {
      const remoteFiles = { ...value.files, 'apps/ops-console/src/styles.css': '.card { color: SENTINEL_DRIFT; }' }
      const result = value.run(remoteFiles)
      expect(result.status).toBe(2)
      expect(result.stderr).toContain('differ from bound sync-plan')
      expect(existsSync(join(value.bundle, 'remote-structure-review.json'))).toBe(false)
      expect(result.stdout).not.toContain('SENTINEL_DRIFT')
      expect(result.stderr).not.toContain('SENTINEL_DRIFT')
    } finally { rmSync(value.root, { recursive: true, force: true }) }
  })

  it('marks a plan-bound remote structure difference without exposing source text', () => {
    const value = fixture({ 'apps/ops-console/src/styles.css': '.card { color: var(--ui); }\n' })
    try {
      const result = value.run()
      expect(result.status, result.stderr).toBe(0)
      const report = JSON.parse(readFileSync(join(value.bundle, 'remote-structure-review.json'), 'utf8'))
      const css = report.structural_review.find((item: { path: string }) => item.path === 'apps/ops-console/src/styles.css')
      expect(css).toMatchObject({ structure_matches: false, remote_summary: { property_names: ['color'] } })
      expect(JSON.stringify(css)).not.toContain('var(--ui)')
    } finally { rmSync(value.root, { recursive: true, force: true }) }
  })

  it('summarizes dependency names without returning versions, scripts, resolved URLs, or invalid package keys', () => {
    const raw = JSON.stringify({
      dependencies: { safe_package: '7.8.9', 'https://private.example/token': 'SENTINEL_VERSION' },
      scripts: { build: 'curl https://private.example/token?key=SENTINEL_SCRIPT' },
    })
    const summary = summarizeReviewBytes('package.json', Buffer.from(raw))
    const serialized = JSON.stringify(summary)
    expect(summary.status).toBe('reviewed')
    expect(serialized).toContain('safe_package')
    for (const value of ['SENTINEL_VERSION', 'SENTINEL_SCRIPT', 'https://private.example']) expect(serialized).not.toContain(value)
  })
})
