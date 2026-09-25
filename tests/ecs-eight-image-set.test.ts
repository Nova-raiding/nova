import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = resolve('infra/scripts/prepare-ecs-eight-image-set.mjs')
const digest = (value: string) => `sha256:${value.repeat(64)}`

describe('ECS eight-image set preparation', () => {
  it('binds six owned images and two reviewed upstream images to one candidate', () => {
    const root = mkdtempSync(join(tmpdir(), 'eight-image-set-'))
    const metadata = join(root, 'release-images.json')
    const identity = join(root, 'candidate-identity')
    const output = join(root, 'output')
    const artifacts = ['merchant-api', 'merchant-worker', 'merchant-ui', 'merchant-ops-ui', 'payment-gateway', 'pilot-gateway']
    const imageDigests = Object.fromEntries(artifacts.map((artifact, index) => [artifact, digest(String(index + 1))]))
    const imageReferences = Object.fromEntries(artifacts.map(artifact => [artifact, `registry.example.com/storenova/${artifact}@${imageDigests[artifact]}`]))
    writeFileSync(metadata, JSON.stringify({ schema_version: 1, release_id: 'release-example', release_git_sha: 'a'.repeat(40), source_sha256: digest('b'), image_digests: imageDigests, image_references: imageReferences }))
    writeFileSync(identity, `release_id=release-example\ngit_sha=${'a'.repeat(40)}\nsource_sha256=${digest('b')}\n`)
    chmodSync(metadata, 0o600); chmodSync(identity, 0o600)
    execFileSync('node', [script, '--release-images', metadata, '--candidate-identity', identity, '--migration-image-ref', `registry.example.com/library/postgres:17-alpine@${digest('c')}`, '--clamav-image-ref', `registry.example.com/clamav@${digest('d')}`, '--output', output])
    const result = JSON.parse(readFileSync(join(output, 'image-digests.json'), 'utf8'))
    expect(Object.keys(result)).toHaveLength(8)
    expect(result['postgres-migration']).toBe(digest('c'))
    expect(result.clamav).toBe(digest('d'))
    expect(readFileSync(join(output, 'image-refs.env'), 'utf8')).toContain('MIGRATION_IMAGE_REF=registry.example.com/library/postgres:17-alpine@')
  })

  it('rejects candidate drift', () => {
    const root = mkdtempSync(join(tmpdir(), 'eight-image-reject-'))
    const metadata = join(root, 'release-images.json')
    const identity = join(root, 'candidate-identity')
    const artifacts = ['merchant-api', 'merchant-worker', 'merchant-ui', 'merchant-ops-ui', 'payment-gateway', 'pilot-gateway']
    const imageDigests = Object.fromEntries(artifacts.map(artifact => [artifact, digest('1')]))
    writeFileSync(metadata, JSON.stringify({ schema_version: 1, release_id: 'release-wrong', release_git_sha: 'a'.repeat(40), source_sha256: digest('b'), image_digests: imageDigests, image_references: {} }))
    writeFileSync(identity, `release_id=release-right\ngit_sha=${'a'.repeat(40)}\nsource_sha256=${digest('b')}\n`)
    expect(() => execFileSync('node', [script, '--release-images', metadata, '--candidate-identity', identity, '--migration-image-ref', 'postgres:17-alpine', '--clamav-image-ref', `registry.example.com/clamav@${digest('d')}`, '--output', join(root, 'out')], { stdio: 'pipe' })).toThrow()
  })

  it('rejects a mutable migration tag', () => {
    const root = mkdtempSync(join(tmpdir(), 'eight-image-mutable-'))
    const metadata = join(root, 'release-images.json')
    const identity = join(root, 'candidate-identity')
    const artifacts = ['merchant-api', 'merchant-worker', 'merchant-ui', 'merchant-ops-ui', 'payment-gateway', 'pilot-gateway']
    const completeDigests = Object.fromEntries(artifacts.map(artifact => [artifact, digest('1')]))
    const references = Object.fromEntries(artifacts.map(artifact => [artifact, `registry.example.com/${artifact}@${completeDigests[artifact]}`]))
    writeFileSync(metadata, JSON.stringify({ schema_version: 1, release_id: 'release-right', release_git_sha: 'a'.repeat(40), source_sha256: digest('b'), image_digests: completeDigests, image_references: references }))
    writeFileSync(identity, `release_id=release-right\ngit_sha=${'a'.repeat(40)}\nsource_sha256=${digest('b')}\n`)
    expect(() => execFileSync('node', [script, '--release-images', metadata, '--candidate-identity', identity, '--migration-image-ref', 'postgres:17-alpine', '--clamav-image-ref', `registry.example.com/clamav@${digest('d')}`, '--output', join(root, 'out')], { stdio: 'pipe' })).toThrow(/Command failed/)
  })

  it.each(['merchant-ui', 'merchant-ops-ui'] as const)('rejects a mutable %s image reference', artifact => {
    const root = mkdtempSync(join(tmpdir(), `eight-image-mutable-${artifact}-`))
    const metadata = join(root, 'release-images.json')
    const identity = join(root, 'candidate-identity')
    const output = join(root, 'out')
    const artifacts = ['merchant-api', 'merchant-worker', 'merchant-ui', 'merchant-ops-ui', 'payment-gateway', 'pilot-gateway']
    const imageDigests = Object.fromEntries(artifacts.map((name, index) => [name, digest(String(index + 1))]))
    const imageReferences = Object.fromEntries(artifacts.map(name => [name, `registry.example.com/${name}@${imageDigests[name]}`]))
    imageReferences[artifact] = `registry.example.com/${artifact}:latest`
    writeFileSync(metadata, JSON.stringify({ schema_version: 1, release_id: 'release-ui-pin', release_git_sha: 'a'.repeat(40), source_sha256: digest('b'), image_digests: imageDigests, image_references: imageReferences }))
    writeFileSync(identity, `release_id=release-ui-pin\ngit_sha=${'a'.repeat(40)}\nsource_sha256=${digest('b')}\n`)
    chmodSync(metadata, 0o600); chmodSync(identity, 0o600)

    expect(() => execFileSync('node', [script, '--release-images', metadata, '--candidate-identity', identity, '--migration-image-ref', `registry.example.com/library/postgres:17-alpine@${digest('c')}`, '--clamav-image-ref', `registry.example.com/clamav@${digest('d')}`, '--output', output], { stdio: 'pipe' })).toThrow(/immutable repository@sha256 reference/)
    expect(existsSync(output)).toBe(false)
  })
})
