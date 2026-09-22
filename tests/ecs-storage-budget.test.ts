import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const script = resolve('infra/scripts/check-ecs-storage-budget.sh')

function run(total: number, used: number, free: number) {
  const root = mkdtempSync(join(tmpdir(), 'storage-budget-')); const bin = join(root, 'bin'); mkdirSync(bin)
  writeFileSync(join(bin, 'df'), `#!/bin/sh\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\nmock ${total} ${used} ${free} 1%% /\\n'\n`, { mode: 0o755 })
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  writeFileSync(join(bin, 'curl'), '#!/bin/sh\nprintf \'{"repositories":["storenova/api"]}\'\n', { mode: 0o755 })
  chmodSync(bin, 0o700)
  return spawnSync('sh', [script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ECS_STORAGE_PROJECTED_GB: '8', ECS_STORAGE_MIN_FREE_GB: '15', ECS_STORAGE_HIGH_WATERMARK_PERCENT: '80' }, encoding: 'utf8' })
}

describe('ECS storage budget gate', () => {
  it('passes below the projected high watermark and emits a report-only registry inventory', () => {
    const result = run(100 * 1024 * 1024, 35 * 1024 * 1024, 65 * 1024 * 1024)
    expect(result.status, result.stderr).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report.status).toBe('passed')
    expect(report.registry).toMatchObject({ repositories: ['storenova/api'], deletion_performed: false, gc_performed: false })
  })

  it('blocks before deployment when projected use reaches the high watermark', () => {
    const result = run(100 * 1024 * 1024, 75 * 1024 * 1024, 25 * 1024 * 1024)
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'blocked', reason: 'projected_high_watermark' })
  })

  it('keeps registry GC report-only and never invokes deletion commands', () => {
    const source = readFileSync(script, 'utf8')
    expect(source).not.toMatch(/garbage-collect|DELETE.*\/v2\/|docker image prune|docker system prune/)
    expect(source).toContain('protected_image_digests')
  })
})
