import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const checkoutCommit = '11d5960a326750d5838078e36cf38b85af677262'
const setupNodeCommit = '49933ea5288caeca8642d1e84afbd3f7d6820020'
const nodeDigest = 'sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32'
const nginxDigest = 'sha256:e7623c006de0ea4716e763083668edd9b732371d5479653c2e709fd0696b0348'

function externalBaseImages(source: string, dockerfile = 'Dockerfile') {
  const stageAliases = new Set<string>()
  const images: string[] = []

  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!/^FROM\s+/iu.test(line)) continue

    const tokens = line.split(/\s+/u)
    let sourceIndex = 1
    while (tokens[sourceIndex]?.startsWith('--')) sourceIndex += 1

    const image = tokens[sourceIndex]
    if (!image) throw new Error(`${dockerfile} contains an invalid FROM line: ${rawLine}`)
    if (!stageAliases.has(image.toLowerCase())) images.push(image)

    if (tokens[sourceIndex + 1]?.toUpperCase() === 'AS') {
      const alias = tokens[sourceIndex + 2]
      if (!alias) throw new Error(`${dockerfile} contains an invalid FROM alias: ${rawLine}`)
      stageAliases.add(alias.toLowerCase())
    }
  }

  return images
}

describe('supply-chain reproducibility gate', () => {
  it('pins every GitHub Action to an immutable commit and grants only read access to repository contents', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8')
    const actionReferences = [...workflow.matchAll(/^\s*- uses:\s*([^\s#]+)/gmu)].map((match) => match[1]!)

    expect(workflow).toMatch(/^permissions:\n  contents: read$/mu)
    expect(workflow).not.toMatch(/^\s+[a-z-]+:\s*write\s*$/gmu)
    expect(actionReferences).toEqual([
      `actions/checkout@${checkoutCommit}`,
      `actions/setup-node@${setupNodeCommit}`,
    ])
    expect(actionReferences.every((reference) => /@[0-9a-f]{40}$/u.test(reference))).toBe(true)
  })

  it('pins every production Dockerfile base image to the approved manifest digest while retaining its readable tag', () => {
    const expectedBases = new Map([
      ['node:22-alpine', nodeDigest],
      ['nginxinc/nginx-unprivileged:1.27-alpine', nginxDigest],
    ])
    const dockerfiles = [
      'infra/docker/api.Dockerfile',
      'infra/docker/worker.Dockerfile',
      'infra/docker/ui.Dockerfile',
      'infra/docker/ops-console.Dockerfile',
    ]
    let baseCount = 0

    for (const dockerfile of dockerfiles) {
      const source = readFileSync(dockerfile, 'utf8')
      const images = externalBaseImages(source, dockerfile)
      expect(images.length, `${dockerfile} must declare a base image`).toBeGreaterThan(0)

      for (const image of images) {
        const [tag, digest] = image.split('@')
        if (!tag) throw new Error(`${dockerfile} contains an invalid base image: ${image}`)
        expect(expectedBases.has(tag), `${dockerfile} uses an unapproved base tag: ${tag}`).toBe(true)
        expect(digest, `${dockerfile} must pin ${tag} to a digest`).toBe(expectedBases.get(tag))
        expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/u)
        baseCount += 1
      }
    }

    expect(baseCount).toBe(8)
  })

  it('keeps CI on PostgreSQL 17 and runs current migration, real PostgreSQL, build, freshness, and release gates', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8')
    const releaseGates = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> }
    const releaseGateCommand = releaseGates.scripts?.['test:release-gates'] ?? ''

    expect(workflow).toContain('image: postgres:17-alpine')
    expect(workflow).toContain('- run: npm run check')
    expect(workflow).toContain('run: npm run test:release-gates')
    expect(workflow).toContain('packages/persistence/src/migration-081-release.postgres.test.ts')
    expect(workflow).toContain('packages/persistence/src/migration-101.test.ts')
    expect(workflow).toContain('STORAGE_QUOTA_DATABASE_URL: postgres://merchant:merchant@127.0.0.1:5432/merchant')
    expect(workflow).toContain('packages/persistence/src/storage-quota-repository.postgres.test.ts')
    expect(workflow).toContain('- run: npm run build')
    expect(releaseGateCommand).toContain('tests/container-source-freshness.test.ts')
    expect(releaseGateCommand).toContain('packages/persistence/src/migration-079.test.ts')
    expect(releaseGateCommand).toContain('packages/persistence/src/migration-080.test.ts')
    for (const gate of readdirSync('tests').filter(file => /-gates?\.test\.ts$/u.test(file))) {
      expect(releaseGateCommand, `${gate} must run in the explicit release gate`).toContain(`tests/${gate}`)
    }
  })

  it('does not treat a previously declared Dockerfile stage alias as an external base image', () => {
    const source = [
      `FROM --platform=$BUILDPLATFORM node:22-alpine@${nodeDigest} AS build`,
      'FROM BUILD AS runtime',
    ].join('\n')

    expect(externalBaseImages(source)).toEqual([`node:22-alpine@${nodeDigest}`])
  })
})
