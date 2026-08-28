import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const digest = `sha256:${'a'.repeat(64)}`

function runManifest(manifest: string) {
  const directory = mkdtempSync(join(tmpdir(), 'merchant-kubernetes-release-gate-'))
  const path = join(directory, 'rendered.yaml')
  writeFileSync(path, manifest)
  return () => execFileSync('sh', ['infra/scripts/validate-kubernetes-release.sh', path, digest], { encoding: 'utf8', stdio: 'pipe' })
}

function deployment(podSpec: string) {
  return [
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata: {name: merchant-api}',
    'spec:',
    '  template:',
    '    spec:',
    ...podSpec.split('\n').map(line => `      ${line}`),
  ].join('\n')
}

describe('structured Kubernetes release image gate', () => {
  it('accepts quoted image keys and every supported PodSpec container class when all digests match', () => {
    const manifest = deployment([
      'containers:',
      `  - {name: api, "image": registry.example.com/merchant-api@${digest}}`,
      'initContainers:',
      `  - {name: migrate, "image": registry.example.com/merchant-api@${digest}}`,
      'ephemeralContainers:',
      `  - {name: diagnostic, "image": registry.example.com/merchant-api@${digest}}`,
    ].join('\n'))
    expect(runManifest(manifest)()).toContain('images=3')
  })

  it('rejects a quoted mutable workload image even when a ConfigMap contains a valid digest decoy', () => {
    const manifest = [
      'apiVersion: v1',
      'kind: ConfigMap',
      'metadata: {name: digest-decoy}',
      'data:',
      `  image: registry.example.com/decoy@${digest}`,
      '---',
      deployment('containers: [{name: api, "image": registry.example.com/merchant-api:latest}]'),
    ].join('\n')
    expect(runManifest(manifest)).toThrow(/mutable|immutable/)
  })

  it('rejects a mutable initContainer even when the application container is immutable', () => {
    const manifest = deployment([
      `containers: [{name: api, image: registry.example.com/merchant-api@${digest}}]`,
      'initContainers: [{name: migrate, "image": registry.example.com/migrations:latest}]',
    ].join('\n'))
    expect(runManifest(manifest)).toThrow(/initContainers.*migrate|mutable|immutable/)
  })

  it('rejects a manifest where a ConfigMap is the only source of an image field', () => {
    const manifest = ['apiVersion: v1', 'kind: ConfigMap', 'metadata: {name: digest-decoy}', 'data:', `  image: registry.example.com/decoy@${digest}`].join('\n')
    expect(runManifest(manifest)).toThrow(/no supported workload container image/)
  })

  it('rejects a workload container with a different immutable digest', () => {
    const wrongDigest = `sha256:${'b'.repeat(64)}`
    expect(runManifest(deployment(`containers: [{name: api, image: registry.example.com/merchant-api@${wrongDigest}}]`))).toThrow(/does not match IMAGE_DIGEST/)
  })

  it('fails closed for unsupported Kubernetes resource kinds', () => {
    const manifest = ['apiVersion: example.com/v1', 'kind: Rollout', 'metadata: {name: merchant-api}', 'spec: {}'].join('\n')
    expect(runManifest(manifest)).toThrow(/unsupported Kubernetes resource kind: Rollout/)
  })

  it('fails closed for malformed YAML and aliases', () => {
    expect(runManifest('apiVersion: apps/v1\nkind: Deployment\nspec: [')).toThrow(/invalid Kubernetes YAML/)
    expect(runManifest('apiVersion: v1\nkind: ConfigMap\nmetadata: &meta {name: alias}\ndata: *meta')).toThrow(/anchors and aliases are not allowed/)
  })
})
