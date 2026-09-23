import { randomBytes } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const image = 'node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32'
const names = ['api-replica', 'worker-automation', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-scan', 'worker-sync']

describe('bridge candidate map from real stopped Docker containers', () => {
  it('freezes exactly seven Compose-owned service names and full IDs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-candidate-map-'))
    const project = `bridgecandidate${randomBytes(4).toString('hex')}`
    const compose = join(dir, 'compose.yml'), output = join(dir, 'candidate-map.json')
    writeFileSync(compose, `services:\n${names.map(name => `  ${name}:\n    image: ${image}\n    command: ["sleep", "600"]\n`).join('')}`)
    const args = ['compose', '-p', project, '-f', compose]
    try {
      execFileSync('docker', [...args, 'create', '--no-build', '--pull', 'never', '--no-recreate', '-y', ...names], { stdio: 'pipe' })
      execFileSync('node', ['infra/scripts/create-ecs-bridge-candidate-map.mjs', project, output], { stdio: 'pipe' })
      const rows = JSON.parse(readFileSync(output, 'utf8')) as { service: string; container: string }[]
      expect(rows.map(row => row.service)).toEqual(names)
      expect(rows.every(row => row.container.startsWith(`${project}-`) && row.container.endsWith('-1'))).toBe(true)
      expect(statSync(output).mode & 0o777).toBe(0o600)
      expect(spawnSync('node', ['infra/scripts/create-ecs-bridge-candidate-map.mjs', project, output], { encoding: 'utf8' }).status).not.toBe(0)
    } finally {
      spawnSync('docker', [...args, 'down'], { stdio: 'pipe' })
      rmSync(dir, { recursive: true })
    }
  }, 30_000)
})
