import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createHandoffCore, digestPath } from '../infra/scripts/ecs-external-gateway-handoff.mjs'

const script = 'infra/scripts/ecs-external-gateway-handoff.mjs'
const id = 'a'.repeat(64), image = `sha256:${'b'.repeat(64)}`
const base = (mounts: unknown[] = [], overrides: Record<string, unknown> = {}) => ({ Id: id, Image: image, Config: { Image: `gateway@${image}`, Labels: { 'com.docker.compose.project': 'old-project', 'com.docker.compose.service': 'pilot-gateway' }, Entrypoint: ['/docker-entrypoint.sh'], Cmd: ['nginx'], Env: ['CERT_REF=hidden-secret'], Healthcheck: { Test: ['CMD', 'true'] } }, HostConfig: { PortBindings: { '8080/tcp': [{ HostPort: '80' }], '8443/tcp': [{ HostPort: '443' }] }, RestartPolicy: { Name: 'always' }, NetworkMode: 'default' }, Mounts: mounts, NetworkSettings: { Networks: { merchant: { NetworkID: 'net-1', Aliases: ['pilot-gateway'] } } }, State: { Running: true }, ...overrides })
const run = (args: string[]) => execFileSync('node', [script, ...args], { encoding: 'utf8', stdio: 'pipe' })

describe('external gateway handoff safety boundary', () => {
  it.each([[[]], [['delete']]] as [string[]][])('rejects invalid CLI action %j', args => expect(() => run(args)).toThrow())
  it('rejects unknown and duplicate CLI arguments without exposing input', () => {
    for (const args of [['check-ports', '--secret', 'top-secret'], ['check-ports', '--candidate-project', 'x', '--candidate-project', 'y']]) {
      const result = spawnSync('node', [script, ...args], { encoding: 'utf8' }); expect(result.status).not.toBe(0); expect(result.stderr).not.toContain('top-secret')
    }
  })
  it('requires state, lock, full id, project and service', () => expect(() => run(['snapshot'])).toThrow())

  it('hashes real certificate directories recursively to a 64-hex digest', () => {
    const root = mkdtempSync(join(tmpdir(), 'gateway-certs-')); mkdirSync(join(root, 'nested')); writeFileSync(join(root, 'a.pem'), 'cert-a'); writeFileSync(join(root, 'nested', 'b.pem'), 'cert-b')
    expect(digestPath(root)).toMatch(/^[a-f0-9]{64}$/)
    expect(digestPath(root)).toBe(digestPath(root))
  })
  it('rejects symlinked certificate mounts', () => {
    const root = mkdtempSync(join(tmpdir(), 'gateway-certs-')); const target = join(root, 'target'); writeFileSync(target, 'cert'); symlinkSync(target, join(root, 'link'))
    expect(() => digestPath(join(root, 'link'))).toThrow(/symlink/)
  })
  it('hashes Certbot file links within the mount but rejects links escaping it', () => {
    const root = mkdtempSync(join(tmpdir(), 'gateway-certbot-'))
    mkdirSync(join(root, 'live')); mkdirSync(join(root, 'archive'))
    writeFileSync(join(root, 'archive', 'cert.pem'), 'certificate')
    symlinkSync('../archive/cert.pem', join(root, 'live', 'cert.pem'))
    const original = digestPath(root)
    expect(original).toMatch(/^[a-f0-9]{64}$/)
    writeFileSync(join(root, 'archive', 'cert.pem'), 'renewed-certificate')
    expect(digestPath(root)).not.toBe(original)
    symlinkSync('/etc/passwd', join(root, 'live', 'escape'))
    expect(() => digestPath(root)).toThrow(/inside the mount/)
  })

  it('snapshot record is immutable and contains no raw secret values', () => {
    const root = mkdtempSync(join(tmpdir(), 'gateway-certs-')); writeFileSync(join(root, 'cert.pem'), 'private-cert')
    const core = createHandoffCore({ inspect: () => base([{ Type: 'bind', Source: root, Destination: '/etc/nginx/certs', RW: false }]), stop: () => undefined, start: () => undefined, lockProbe: () => true, otherRunningPortCheck: () => false })
    const saved = core.snapshot({ id, project: 'old-project', service: 'pilot-gateway' }); const encoded = JSON.stringify(saved)
    expect(encoded).not.toContain('hidden-secret'); expect(encoded).not.toContain('private-cert'); expect(saved.image_id).toBe(image); expect(saved.mounts[0]!.content_sha256).toMatch(/^[a-f0-9]{64}$/)
  })
  it('lock false rejects snapshot and mutation', () => {
    const core = createHandoffCore({ inspect: () => base(), stop: () => undefined, start: () => undefined, lockProbe: () => false, otherRunningPortCheck: () => false })
    expect(() => core.snapshot({ id, project: 'old-project', service: 'pilot-gateway' })).toThrow(/lock/)
  })
  it('requires an explicit legacy-unmanaged target for a gateway without Compose labels', () => {
    const live = base(); live.Config.Labels = {} as typeof live.Config.Labels
    const core = createHandoffCore({ inspect: () => live, stop: () => undefined, start: () => undefined, lockProbe: () => true, otherRunningPortCheck: () => false })
    expect(() => core.snapshot({ id, project: 'old-project', service: 'pilot-gateway' })).toThrow(/identity/)
    expect(core.snapshot({ id, project: 'legacy-unmanaged', service: 'pilot-gateway' })).toMatchObject({ ownership_mode: 'legacy-unmanaged', compose_project: null, compose_service: null })
    live.Config.Labels['com.docker.compose.project'] = 'unexpected'
    expect(() => core.snapshot({ id, project: 'legacy-unmanaged', service: 'pilot-gateway' })).toThrow(/identity/)
  })
  it('blocks handoff when the old gateway cannot reach the candidate API network', () => {
    const core = createHandoffCore({ inspect: () => base(), stop: () => undefined, start: () => undefined, lockProbe: () => true, otherRunningPortCheck: () => false })
    expect(() => core.snapshot({ id, project: 'old-project', service: 'pilot-gateway', requiredNetwork: 'new-production' })).toThrow(/share the candidate API network/)
    expect(core.snapshot({ id, project: 'old-project', service: 'pilot-gateway', requiredNetwork: 'merchant' }).running).toBe(true)
  })

  it('performs stop, restore, and repeated restore with verified calls', () => {
    let live = base(), stops = 0, starts = 0
    const core = createHandoffCore({ inspect: () => live, stop: () => { stops++; live = base([], { State: { Running: false } }) }, start: () => { starts++; live = base() }, lockProbe: () => true, otherRunningPortCheck: () => false })
    const saved = core.snapshot({ id, project: 'old-project', service: 'pilot-gateway' }); core.stopAndRestore({ saved, id, project: 'old-project', service: 'pilot-gateway' }); expect(stops).toBe(1); core.stopAndRestore({ saved, id, project: 'old-project', service: 'pilot-gateway', restore: true }); core.stopAndRestore({ saved, id, project: 'old-project', service: 'pilot-gateway', restore: true }); expect(starts).toBe(1)
  })
  it('does not swallow stop/start errors', () => {
    const saved = createHandoffCore({ inspect: () => base(), stop: () => { throw new Error('stop-failed') }, start: () => { throw new Error('start-failed') }, lockProbe: () => true, otherRunningPortCheck: () => false }).snapshot({ id, project: 'old-project', service: 'pilot-gateway' })
    expect(() => createHandoffCore({ inspect: () => base(), stop: () => { throw new Error('stop-failed') }, start: () => undefined, lockProbe: () => true, otherRunningPortCheck: () => false }).stopAndRestore({ saved, id, project: 'old-project', service: 'pilot-gateway' })).toThrow('stop-failed')
    expect(() => createHandoffCore({ inspect: () => base([], { State: { Running: false } }), stop: () => undefined, start: () => { throw new Error('start-failed') }, lockProbe: () => true, otherRunningPortCheck: () => false }).stopAndRestore({ saved, id, project: 'old-project', service: 'pilot-gateway', restore: true })).toThrow('start-failed')
  })

  it.each(['image', 'env', 'network', 'mount', 'port'])('rejects %s drift before stop', kind => {
    const root = mkdtempSync(join(tmpdir(), 'gateway-certs-')); writeFileSync(join(root, 'cert.pem'), 'cert')
    const original = base([{ Type: 'bind', Source: root, Destination: '/etc/nginx/certs', RW: false }]); const saved = createHandoffCore({ inspect: () => original, stop: () => undefined, start: () => undefined, lockProbe: () => true, otherRunningPortCheck: () => false }).snapshot({ id, project: 'old-project', service: 'pilot-gateway' })
    const drift = structuredClone(original) as any; if (kind === 'image') drift.Image = `sha256:${'c'.repeat(64)}`; if (kind === 'env') drift.Config.Env = ['CERT_REF=changed']; if (kind === 'network') drift.NetworkSettings.Networks.merchant.NetworkID = 'changed'; if (kind === 'mount') drift.Mounts[0].Source = '/missing'; if (kind === 'port') drift.HostConfig.PortBindings['8080/tcp'][0].HostPort = '81'
    for (const restore of [false, true]) {
      let mutations = 0
      const changed = createHandoffCore({ inspect: () => drift, stop: () => { mutations++ }, start: () => { mutations++ }, lockProbe: () => true, otherRunningPortCheck: () => false })
      expect(() => changed.stopAndRestore({ saved, id, project: 'old-project', service: 'pilot-gateway', restore })).toThrow()
      expect(mutations).toBe(0)
    }
  })
  it('rejects another running gateway on the protected ports', () => {
    const core = createHandoffCore({ inspect: () => base(), stop: () => undefined, start: () => undefined, lockProbe: () => true, otherRunningPortCheck: () => false }); const saved = core.snapshot({ id, project: 'old-project', service: 'pilot-gateway' }); const guarded = createHandoffCore({ inspect: () => base(), stop: () => undefined, start: () => undefined, lockProbe: () => true, otherRunningPortCheck: () => true })
    expect(() => guarded.stopAndRestore({ saved, id, project: 'old-project', service: 'pilot-gateway', restore: true })).toThrow(/another gateway/)
  })
})
