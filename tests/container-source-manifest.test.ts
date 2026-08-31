import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const generator = 'infra/scripts/generate-container-source-manifest.mjs'
const temporaryDirectories: string[] = []

function write(root: string, path: string, contents: string) {
  const destination = join(root, path)
  mkdirSync(join(destination, '..'), { recursive: true })
  writeFileSync(destination, contents)
}

function sourceFixture() {
  const root = mkdtempSync(join(tmpdir(), 'container-source-manifest-'))
  temporaryDirectories.push(root)
  write(root, 'apps/api/src/server.ts', 'api\n')
  write(root, 'apps/plugin/mcp/bridge.mjs', 'plugin\n')
  write(root, 'apps/worker/src/main.ts', 'worker\n')
  write(root, 'packages/shared/src/index.ts', 'shared\n')
  write(root, 'package.json', '{}\n')
  write(root, 'package-lock.json', '{}\n')
  write(root, 'tsconfig.json', '{}\n')
  return root
}

function generate(root: string, profile: 'api' | 'worker') {
  const output = join(root, 'output')
  const manifest = join(output, `${profile}.manifest`)
  const digest = join(output, `${profile}.manifest.sha256`)
  execFileSync('node', [generator, 'generate', profile, root, manifest, digest])
  return { manifest, digest }
}

afterEach(() => {
  while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
})

describe('deterministic container source manifest', () => {
  it('uses fixed app-specific profiles while both profiles cover shared packages and root build metadata', () => {
    const root = sourceFixture()
    const api = readFileSync(generate(root, 'api').manifest, 'utf8')
    const worker = readFileSync(generate(root, 'worker').manifest, 'utf8')

    expect(api).toContain('apps/api/src/server.ts')
    expect(api).toContain('apps/plugin/mcp/bridge.mjs')
    expect(api).not.toContain('apps/worker/src/main.ts')
    expect(worker).toContain('apps/worker/src/main.ts')
    expect(worker).not.toContain('apps/api/src/server.ts')
    for (const manifest of [api, worker]) {
      expect(manifest).toContain('packages/shared/src/index.ts')
      expect(manifest).toContain('package-lock.json')
      expect(manifest).toContain('package.json')
      expect(manifest).toContain('tsconfig.json')
    }
  })

  it('generates both profiles in one process without changing either manifest', () => {
    const root = sourceFixture()
    const api = generate(root, 'api')
    const apiManifest = readFileSync(api.manifest)
    const apiDigest = readFileSync(api.digest)
    const worker = generate(root, 'worker')
    const workerManifest = readFileSync(worker.manifest)
    const workerDigest = readFileSync(worker.digest)
    const output = join(root, 'pair-output')

    execFileSync('node', [generator, 'generate-pair', root, join(output, 'api'), join(output, 'worker')])

    expect(readFileSync(join(output, 'api.manifest'))).toEqual(apiManifest)
    expect(readFileSync(join(output, 'api.manifest.sha256'))).toEqual(apiDigest)
    expect(readFileSync(join(output, 'worker.manifest'))).toEqual(workerManifest)
    expect(readFileSync(join(output, 'worker.manifest.sha256'))).toEqual(workerDigest)
  })

  it('is byte-stable and excludes dist, maps, tests, artifacts, secrets, and env files', () => {
    const root = sourceFixture()
    write(root, 'apps/api/dist/server.js', 'built\n')
    write(root, 'apps/api/src/server.js.map', '{}\n')
    write(root, 'apps/api/src/server.test.ts', 'test\n')
    write(root, 'apps/api/src/server.test.d.ts', 'test declaration\n')
    write(root, 'apps/api/src/server.fixture.json', '{}\n')
    write(root, 'packages/shared/test-results/result.json', '{}\n')
    write(root, 'packages/shared/secrets/token.txt', 'secret\n')
    write(root, 'packages/shared/src/.secret-token', 'secret\n')
    write(root, 'packages/shared/.env.production', 'TOKEN=secret\n')
    const first = generate(root, 'api')
    const firstManifest = readFileSync(first.manifest)
    const firstDigest = readFileSync(first.digest, 'utf8')
    const second = generate(root, 'api')

    expect(readFileSync(second.manifest)).toEqual(firstManifest)
    expect(readFileSync(second.digest, 'utf8')).toBe(firstDigest)
    const text = firstManifest.toString('utf8')
    expect(text).not.toMatch(/dist|\.map|\.test\.|\.fixture\.|test-results|secret|\.env/)
    expect(firstDigest).toBe(`sha256:${createHash('sha256').update(firstManifest).digest('hex')}\n`)
  })

  it('fails closed for missing required scopes and symbolic links in included inputs', () => {
    const missing = sourceFixture()
    rmSync(join(missing, 'apps/worker'), { recursive: true })
    expect(() => generate(missing, 'worker')).toThrow(/required worker input is missing/)

    const linked = sourceFixture()
    symlinkSync(join(linked, 'package.json'), join(linked, 'apps/api/src/package-link.json'))
    expect(() => generate(linked, 'api')).toThrow(/symbolic links are forbidden/)

    const missingMetadata = sourceFixture()
    rmSync(join(missingMetadata, 'package-lock.json'))
    expect(() => generate(missingMetadata, 'api')).toThrow(/required root build metadata is missing: package-lock.json/)
  })

  it('validates total digest, strict ordering, duplicate paths, and path safety independently', () => {
    const root = sourceFixture()
    const { manifest, digest } = generate(root, 'api')
    execFileSync('node', [generator, 'verify', 'api', manifest, digest])

    const validLines = readFileSync(manifest, 'utf8').trimEnd().split('\n')
    writeFileSync(manifest, `${validLines.slice().reverse().join('\n')}\n`)
    writeFileSync(digest, `sha256:${createHash('sha256').update(readFileSync(manifest)).digest('hex')}\n`)
    expect(() => execFileSync('node', [generator, 'verify', 'api', manifest, digest])).toThrow(/not strictly sorted/)

    const unsafe = `${'a'.repeat(64)}  ..\/escape.ts\n`
    writeFileSync(manifest, unsafe)
    writeFileSync(digest, `sha256:${createHash('sha256').update(unsafe).digest('hex')}\n`)
    expect(() => execFileSync('node', [generator, 'verify', 'api', manifest, digest])).toThrow(/unsafe path/)
  })
})
