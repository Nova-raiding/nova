import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const helper = resolve('infra/scripts/acquire-ecs-review-source.mjs')

function fixture(remoteContent: string) {
  const root = mkdtempSync(join(tmpdir(), 'ecs-review-acquisition-'))
  const bundle = join(root, 'candidate')
  const bin = join(root, 'bin')
  mkdirSync(bundle); mkdirSync(bin)
  const sourcePath = 'apps/api/src/server.ts'
  const manifest = Buffer.from(`${sourcePath}\n`)
  const plan = Buffer.from(`status\tlocal_sha256\tremote_sha256\tpath\nreview_required\t${digest('candidate')}\t${digest('expected')}\t${sourcePath}\n`)
  const archive = Buffer.from('fixture candidate source archive')
  writeFileSync(join(bundle, 'files.txt'), manifest)
  writeFileSync(join(bundle, 'sync-plan.tsv'), plan)
  writeFileSync(join(bundle, 'candidate-source.tar'), archive)
  writeFileSync(join(bundle, 'candidate-identity.txt'), [
    `git_sha=${'a'.repeat(40)}`,
    `source_sha256=sha256:${digest(archive)}`,
    `comparison_manifest_sha256=sha256:${digest(manifest)}`,
    `sync_plan_sha256=sha256:${digest(plan)}`,
  ].join('\n'))
  const ssh = join(bin, 'ssh')
  writeFileSync(ssh, `#!/usr/bin/env node\nlet input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{const data=Buffer.from(process.env.FAKE_SOURCE_CONTENT,'utf8');for(const path of input.trimEnd().split('\\n')){process.stdout.write(JSON.stringify({path,size:data.length,sha256:require('node:crypto').createHash('sha256').update(data).digest('hex')})+'\\n');process.stdout.write(data)}})\n`)
  chmodSync(ssh, 0o700)
  const run = () => spawnSync(process.execPath, [helper, bundle], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_SOURCE_CONTENT: remoteContent } })
  return { root, bundle, run }
}

describe('ECS source review acquisition binding', () => {
  it('rejects remote bytes that drift from the candidate sync-plan and publishes no partial review directory', () => {
    const value = fixture('drifted')
    try {
      const result = value.run()
      expect(result.status).toBe(2)
      expect(result.stderr).toContain('no longer matches reviewed sync-plan digest')
      expect(existsSync(join(value.bundle, 'remote-review-source'))).toBe(false)
      expect(readdirSync(value.bundle).filter((name) => name.startsWith('.remote-review-source-staging-'))).toEqual([])
    } finally { rmSync(value.root, { recursive: true, force: true }) }
  })

  it('atomically publishes review evidence when returned bytes match the bound remote digest', () => {
    const value = fixture('expected')
    try {
      const result = value.run()
      expect(result.status).toBe(0)
      const output = join(value.bundle, 'remote-review-source')
      expect(readFileSync(join(output, 'apps/api/src/server.ts'), 'utf8')).toBe('expected')
      expect(JSON.parse(readFileSync(join(output, 'review-acquisition.json'), 'utf8')).files[0].remote_sha256).toBe(digest('expected'))
      expect(readdirSync(value.bundle).filter((name) => name.startsWith('.remote-review-source-staging-'))).toEqual([])
    } finally { rmSync(value.root, { recursive: true, force: true }) }
  })
})
