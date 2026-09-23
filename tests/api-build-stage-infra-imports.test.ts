import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function testFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return testFiles(path)
    return entry.isFile() && /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(entry.name) ? [path] : []
  })
}

describe('API image build-stage host helper imports', () => {
  it('copies checked-in infra scripts for root test typechecking without widening runtime or source identity', () => {
    const dockerfile = readFileSync('infra/docker/api.Dockerfile', 'utf8')
    const [buildStage = '', runtimeStage = ''] = dockerfile.split(/^FROM .* AS runtime$/mu)
    expect(buildStage).toContain('COPY tests ./tests')
    expect(buildStage).toContain('COPY infra/scripts ./infra/scripts')
    expect(buildStage.indexOf('COPY infra/scripts ./infra/scripts')).toBeLessThan(buildStage.indexOf('RUN npm run build'))
    expect(runtimeStage).not.toContain('COPY infra/scripts')
    expect(runtimeStage).not.toContain('/app/infra/scripts')

    const imports = testFiles(resolve('tests')).flatMap(file => {
      const source = readFileSync(file, 'utf8')
      return [...source.matchAll(/from\s+['"]([^'"]*\/infra\/scripts\/[^'"]+)['"]/gu)]
        .map(match => resolve(file, '..', match[1]!))
    })
    expect(imports.length).toBeGreaterThan(0)
    for (const path of imports) expect(existsSync(path), path).toBe(true)

    const manifest = readFileSync('infra/scripts/generate-container-source-manifest.mjs', 'utf8')
    const apiProfile = manifest.split('api: Object.freeze({')[1]?.split('worker: Object.freeze({')[0] ?? ''
    expect(apiProfile).toContain("scopes: Object.freeze(['apps/api', 'packages'])")
    expect(apiProfile).not.toContain('infra/scripts')
  })

  it('keeps the worker on its scoped TypeScript build, without root test imports', () => {
    const dockerfile = readFileSync('infra/docker/worker.Dockerfile', 'utf8')
    expect(dockerfile).toContain('npx tsc -p apps/worker/tsconfig.build.json')
    expect(dockerfile).not.toContain('RUN npm run build\n')
  })
})
