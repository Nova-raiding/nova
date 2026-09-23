import { chmodSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { cloneSpec, greenSpec, publicPlan, rotateGrants, rotateReplicaPair, rotateWithGateway, snapshotReplica, preflightEngineClone, writeProtectedRotation, executeAgainstEngine } from '../infra/scripts/rotation/api-replica-credentials.mjs'
import { sha256 } from '../infra/scripts/rotation/gateway-upstream-handoff.mjs'
import { DockerEngine } from '../infra/scripts/rotation/docker-engine.mjs'

const grants = { ['a'.repeat(24)]: { workspaces: ['ws_a'], roles: ['merchant_admin'], actor_id: 'actor_a', bootstrap: false } }
const raw = JSON.stringify(grants)
const secret = 'a'.repeat(24)
const image = `sha256:${'b'.repeat(64)}`
const sample = (name: string, suffix: string) => ({
  Id: suffix.repeat(64), Name: `/${name}`, Image: image, State: { Running: true },
  Config: { Image: 'registry.example.test/api:old', Env: [`API_AUTH_TOKENS=${raw}`, 'NODE_ENV=production'],
    Labels: { 'com.docker.compose.service': name }, Healthcheck: { Test: ['CMD-SHELL', 'curl -f localhost/readyz'], Interval: 10000000000 },
    Volumes: { '/app/data': {} }, Entrypoint: ['node'], Cmd: ['server.js'] },
  HostConfig: { NetworkMode: 'app_default', RestartPolicy: { Name: 'unless-stopped' },
    PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18080' }] },
    Binds: ['/host/a:/app/data:ro'], Memory: 536870912 },
  Mounts: [{ Type: 'bind', Source: '/host/a', Destination: '/app/data', RW: false }],
  NetworkSettings: { Networks: {
    app_default: { NetworkID: 'net-default', Aliases: [name, 'api-service'], IPAMConfig: null },
    app_front: { NetworkID: 'net-front', Aliases: [name, 'api-service-front'], IPAMConfig: null },
  } },
})

describe('API replica credential rotation dry-run', () => {
  it('rotates keys and preserves every grant property', () => {
    const result = rotateGrants(raw, () => Buffer.alloc(32, 7))
    expect(Object.keys(result.rotated)).not.toContain(secret)
    expect(Object.values(result.rotated)).toEqual(Object.values(grants))
    expect(result.keyMap[secret]).toHaveLength(43)
  })
  it('pins immutable image and preserves host, volume, health and both networks', () => {
    const original = sample('api', 'c')
    const snapshot = snapshotReplica(original, raw)
    const spec = cloneSpec(snapshot, rotateGrants(raw).raw)
    expect(spec.Image).toBe(image)
    expect(spec.Config.Image).toBe(image)
    expect(spec.HostConfig).toEqual(original.HostConfig)
    expect(spec.Config.Healthcheck).toEqual(original.Config.Healthcheck)
    expect(spec.Config.Volumes).toEqual(original.Config.Volumes)
    expect(spec.NetworkingConfig.EndpointsConfig.app_default.Aliases).toEqual(['api', 'api-service'])
    expect(spec.secondary).toEqual([{ name: 'app_front', endpoint: { Aliases: ['api', 'api-service-front'], IPAMConfig: null, Links: null, DriverOpts: null } }])
    expect(spec.Config.Env.find((value: string) => value.startsWith('API_AUTH_TOKENS='))).not.toContain(secret)
  })
  it('reports no secrets and rejects drift, missing network, and unsafe grants', () => {
    const first = sample('api', 'c'), second = sample('api-replica', 'd')
    const report = publicPlan([first, second], raw).report
    expect(JSON.stringify(report)).not.toContain(secret)
    expect(report.replica_count).toBe(2)
    expect(report.replicas.map((replica: any) => replica.networks.length)).toEqual([2, 2])
    expect(() => publicPlan([first, second], JSON.stringify({ [secret]: { workspaces: ['ws_other'] } }))).toThrow('AUTH_SOURCE_MISMATCH')
    delete (second.NetworkSettings.Networks as any).app_front
    expect(() => publicPlan([first, second], raw)).toThrow('EXPECTED_TWO_NETWORKS')
    expect(() => rotateGrants(JSON.stringify({ [secret]: { workspaces: ['*'] } }))).toThrow('UNSCOPED_GRANT')
    first.Config.Env.push(`OTHER_CREDENTIAL=${secret}`)
    expect(() => snapshotReplica(first, raw)).toThrow('OLD_TOKEN_REFERENCED_BY_OTHER_ENV')
  })
  it('CLI accepts protected files and never emits secret values on success or parse failure', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'replica-rotation-')))
    const inspectPath = join(dir, 'inspect.json'), grantsPath = join(dir, 'grants.json')
    writeFileSync(inspectPath, JSON.stringify([sample('api', 'c'), sample('api-replica', 'd')]))
    writeFileSync(grantsPath, raw)
    chmodSync(inspectPath, 0o600); chmodSync(grantsPath, 0o600)
    const args = ['infra/scripts/rotation/api-replica-credentials.mjs', '--dry-run', '--inspect-json', inspectPath, `--grants-file=${grantsPath}`]
    const good = spawnSync('node', args, { encoding: 'utf8' })
    expect(good.status).toBe(0)
    expect(good.stdout).not.toContain(secret)
    expect(good.stderr).toBe('')
    writeFileSync(grantsPath, `{"${secret}":INVALID}`)
    const bad = spawnSync('node', args, { encoding: 'utf8' })
    expect(bad.status).not.toBe(0)
    expect(bad.stderr).not.toContain(secret)
    expect(readFileSync(grantsPath, 'utf8')).toContain(secret)
  })
  it('recovers a failed replacement with rotated keys and never restarts a compromised old container', async () => {
    const originals = [sample('api', 'c'), sample('api-replica', 'd')]
    const plan = publicPlan(originals, raw)
    const live = new Map<string, any>(originals.map(x => [x.Id, structuredClone(x)]))
    const events: string[] = []
    let sequence = 0, failOnce = true
    const adapter = {
      inspect: async (id: string) => live.get(id),
      disableRestart: async (id: string) => { events.push(`disable:${id}`) },
      stop: async (id: string) => { events.push(`stop:${id}`); live.get(id).State.Running = false },
      rename: async (id: string, name: string) => { events.push(`rename:${id}`); live.get(id).Name = `/${name}` },
      create: async (name: string, spec: any) => {
        const id = String(++sequence).repeat(64)
        const source = originals.find(x => x.Name === `/${name}`)!
        live.set(id, { ...structuredClone(source), Id: id, Config: structuredClone(spec.Config), Image: spec.Image, Name: `/${name}`,
          State: { Running: false, Health: { Status: 'starting' } } })
        events.push(`create:${id}`)
        return id
      },
      connect: async (id: string) => { events.push(`connect:${id}`) },
      start: async (id: string) => { events.push(`start:${id}`); live.get(id).State.Running = true },
      waitHealthy: async (id: string) => {
        if (failOnce) { failOnce = false; throw new Error('health failure with secret ' + secret) }
        live.get(id).State.Health.Status = 'healthy'
        events.push(`healthy:${id}`)
      },
      remove: async (id: string) => { events.push(`remove:${id}`); live.delete(id) },
    }
    const result = await rotateReplicaPair(adapter, plan)
    expect(result.status).toBe('recovered_with_rotated_credentials')
    expect(events.filter(x => x.startsWith('start:'))).toHaveLength(3)
    expect(events.some(x => x === `start:${originals[0]!.Id}` || x === `start:${originals[1]!.Id}`)).toBe(false)
    expect(events.findIndex(x => x.startsWith('healthy:'))).toBeLessThan(events.findIndex(x => x === `stop:${originals[1]!.Id}`))
    expect([...live.values()].filter(x => x.State.Running).map(x => x.Config.Env[0])).toEqual([`API_AUTH_TOKENS=${plan.rotation.raw}`, `API_AUTH_TOKENS=${plan.rotation.raw}`])
  })
  it('preflight clone refuses config drift before any old replica is stopped', async () => {
    const plan = publicPlan([sample('api', 'c'), sample('api-replica', 'd')], raw)
    const calls: string[] = []
    const adapter = {
      create: async (_name: string, _spec: any) => { calls.push('create'); return 'e'.repeat(64) },
      connect: async () => { calls.push('connect') },
      inspectNetwork: async (name: string) => ({ Id: name === 'app_default' ? 'net-default' : 'net-front' }),
      inspect: async () => { const drift = sample('api', 'e'); drift.State.Running = false; drift.Config.Image = image; drift.Config.Healthcheck.Test = ['CMD', 'false']; return drift },
      remove: async () => { calls.push('remove') },
    }
    await expect(preflightEngineClone(adapter, plan)).rejects.toThrow('CLONE_CONFIG_DRIFT')
    expect(calls).toEqual(['create', 'connect', 'remove'])
  })
  it('Docker Engine adapter sends exact JSON over a Unix socket and hides response secrets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-docker-'))
    const socket = join(dir, 'docker.sock')
    const seen: Array<{ method: string; path: string; body: any }> = []
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(chunk))
      request.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
        seen.push({ method: request.method ?? '', path: request.url ?? '', body })
        if (request.url?.endsWith('/json')) { response.writeHead(500); response.end(`secret=${secret}`); return }
        response.writeHead(201, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ Id: 'e'.repeat(64) }))
      })
    })
    await new Promise<void>(resolve => server.listen(socket, resolve))
    try {
      const engine = new DockerEngine(socket)
      const id = await engine.create('api', cloneSpec(snapshotReplica(sample('api', 'c'), raw), rotateGrants(raw).raw))
      expect(id).toBe('e'.repeat(64))
      expect(seen[0]?.path).toBe('/v1.44/containers/create?name=api')
      expect(seen[0]?.body.HostConfig).toEqual(sample('api', 'c').HostConfig)
      expect(seen[0]?.body.Config).toBeUndefined()
      expect(seen[0]?.body.NetworkingConfig.EndpointsConfig.app_default.Aliases).toContain('api')
      await expect(engine.inspect('e'.repeat(64))).rejects.toThrow('DOCKER_HTTP_500')
      await expect(engine.inspect('e'.repeat(64))).rejects.not.toThrow(secret)
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  })
  it('writes the new mapping and caller map only to a private, exclusive file', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'private-rotation-')))
    chmodSync(dir, 0o700)
    const output = join(dir, 'credentials.json')
    const rotation = rotateGrants(raw)
    writeProtectedRotation(output, rotation)
    expect(statSync(output).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(output, 'utf8')).api_auth_tokens).toEqual(rotation.rotated)
    expect(() => writeProtectedRotation(output, rotation)).toThrow()
    chmodSync(dir, 0o755)
    expect(() => writeProtectedRotation(join(dir, 'second.json'), rotation)).toThrow('UNPROTECTED_OUTPUT_DIRECTORY')
  })
  it('blocks live execution before touching Docker while public upstream handoff is unproven', async () => {
    let calls = 0
    const engine = { inspect: async () => { calls++; throw new Error('should not inspect') } }
    await expect(executeAgainstEngine({ engine, ids: ['c'.repeat(64), 'd'.repeat(64)], grantsFile: '/protected/grants', outputFile: '/protected/output' })).rejects.toThrow('PUBLIC_UPSTREAM_HANDOFF_NOT_PROVEN')
    expect(calls).toBe(0)
    const cli = spawnSync('node', ['infra/scripts/rotation/api-replica-credentials.mjs', '--execute', '--container-ids', `${'c'.repeat(64)},${'d'.repeat(64)}`, '--grants-file=/missing', '--output-file', '/missing'], { encoding: 'utf8' })
    expect(cli.status).not.toBe(0)
    expect(cli.stderr).toContain('PUBLIC_UPSTREAM_HANDOFF_NOT_PROVEN')
  })

  it('prewarms rotated greens, switches the sole upstream, then stops old replicas', async () => {
    const originals = [sample('api', 'c'), sample('api-replica', 'd')]
    const plan = publicPlan(originals, raw)
    const live = new Map<string, any>(originals.map(x => [x.Id, structuredClone(x)]))
    const events: string[] = []
    let gatewayConfig = 'upstream pilot_api {\n  server api:8787 resolve;\n}\n'
    const initialHash = sha256(gatewayConfig)
    let seq = 0
    const engine = {
      inspect: async (id: string) => live.get(id),
      create: async (name: string, spec: any) => {
        const id = String(++seq).repeat(64)
        const original = originals[seq - 1]!
        const clone = structuredClone(original)
        Object.assign(clone, { Id: id, Name: `/${name}`, Config: spec.Config, HostConfig: spec.HostConfig,
          State: { Running: false, Health: { Status: 'starting' } } })
        live.set(id, clone); events.push(`create:${name}`); return id
      },
      connect: async () => {},
      start: async (id: string) => { live.get(id).State.Running = true; events.push('start') },
      waitHealthy: async (id: string) => { live.get(id).State.Health.Status = 'healthy'; events.push('healthy') },
      disableRestart: async (id: string) => { events.push(`disable:${id}`) },
      stop: async (id: string) => { live.get(id).State.Running = false; events.push(`stop:${id}`) },
      remove: async (id: string) => { live.delete(id); events.push(`remove:${id}`) },
    }
    const gateway = {
      read: async () => gatewayConfig,
      install: async ({ expectedSha256, config, nextSha256 }: any) => {
        expect(expectedSha256).toBe(sha256(gatewayConfig)); expect(nextSha256).toBe(sha256(config))
        gatewayConfig = config; events.push('switch'); return true
      },
      verify: async ({ target, rotated }: any) => {
        expect(gatewayConfig).toContain(`${target}:8787 resolve`)
        expect(rotated.raw).toBe(plan.rotation.raw)
        events.push('verified'); return true
      },
    }
    const result = await rotateWithGateway({ engine, gateway, source: { persist: async () => { events.push('persist'); return true } },
      plan, expectedGatewaySha256: initialHash, publicReplicaName: 'api' })
    expect(result.status).toBe('rotated_gateway')
    expect(events.filter(x => x === 'healthy')).toHaveLength(2)
    expect(events.indexOf('persist')).toBeGreaterThan(events.lastIndexOf('healthy'))
    expect(events.indexOf('switch')).toBeGreaterThan(events.indexOf('persist'))
    expect(events.indexOf('verified')).toBeLessThan(events.findIndex(x => x.startsWith('stop:')))
    expect([...live.values()].filter(x => x.State.Running).map(x => x.Config.Env[0])).toEqual([`API_AUTH_TOKENS=${plan.rotation.raw}`, `API_AUTH_TOKENS=${plan.rotation.raw}`])
  })

  it('rejects shared writable mounts before any green is created', () => {
    const originals = [sample('api', 'c'), sample('api-replica', 'd')]
    const plan = publicPlan(originals, raw)
    expect(greenSpec(plan.snapshots[0], plan.rotation.raw, 'api-green').HostConfig.PortBindings).toEqual({})
    originals[0]!.Mounts[0]!.RW = true
    const unsafe = publicPlan(originals, raw)
    expect(() => greenSpec(unsafe.snapshots[0], unsafe.rotation.raw, 'api-green')).toThrow('WRITABLE_SHARED_MOUNT')
  })

  it('never switches back to compromised credentials after a failed public verification', async () => {
    const originals = [sample('api', 'c'), sample('api-replica', 'd')]
    const plan = publicPlan(originals, raw)
    const live = new Map<string, any>(originals.map(x => [x.Id, structuredClone(x)]))
    const events: string[] = []
    let config = 'upstream pilot_api {\n  server api:8787 resolve;\n}\n'
    let seq = 0
    const engine = {
      inspect: async (id: string) => live.get(id),
      create: async (name: string, spec: any) => {
        const id = String(++seq).repeat(64)
        live.set(id, { ...structuredClone(originals[seq - 1]), Id: id, Name: `/${name}`, Config: spec.Config,
          HostConfig: spec.HostConfig, State: { Running: false, Health: { Status: 'starting' } } })
        return id
      },
      connect: async () => {},
      start: async (id: string) => { live.get(id).State.Running = true },
      waitHealthy: async (id: string) => { live.get(id).State.Health.Status = 'healthy' },
      disableRestart: async () => { events.push('disable-old') },
      stop: async () => { events.push('stop') },
      remove: async () => { events.push('remove') },
    }
    const gateway = {
      read: async () => config,
      install: async ({ config: next }: any) => { config = next; events.push('switch'); return true },
      verify: async () => false,
    }
    await expect(rotateWithGateway({ engine, gateway, source: { persist: async () => true }, plan,
      expectedGatewaySha256: sha256(config), publicReplicaName: 'api' })).rejects.toThrow('POST_SWITCH_MANUAL_RECOVERY_ROTATED_ONLY')
    expect(events).toEqual(['switch'])
    expect(config).toContain('api-rotated-')
    expect([...live.values()].filter(x => x.State.Running)).toHaveLength(4)
  })
})
