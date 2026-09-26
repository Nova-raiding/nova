#!/usr/bin/env node
// Emergency API credential rotation. All diagnostic output is deliberately
// secret-free; never interpolate Docker or JSON parse errors into messages.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync, lstatSync, realpathSync, openSync, writeFileSync, fsyncSync, closeSync, constants } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'

const fail = code => { throw new Error(code) }
const ensure = (condition, code) => { if (!condition) fail(code) }
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fullId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const normalizedHostConfig = config => ({ ...config, OomKillDisable: Boolean(config.OomKillDisable) })

export function envValue(env, key) {
  ensure(Array.isArray(env), 'INVALID_ENV')
  const matches = env.filter(value => typeof value === 'string' && value.startsWith(`${key}=`))
  ensure(matches.length === 1, 'MISSING_OR_DUPLICATE_AUTH_ENV')
  return matches[0].slice(key.length + 1)
}

export function parseGrants(raw) {
  let grants
  try { grants = JSON.parse(raw) } catch { fail('INVALID_GRANTS_JSON') }
  ensure(plain(grants) && Object.keys(grants).length > 0, 'EMPTY_OR_INVALID_GRANTS')
  for (const [key, grant] of Object.entries(grants)) {
    ensure(typeof key === 'string' && key.length >= 16 && plain(grant), 'INVALID_GRANT')
    ensure(Array.isArray(grant.workspaces) && grant.workspaces.length > 0 && !grant.workspaces.includes('*'), 'UNSCOPED_GRANT')
    ensure(grant.bootstrap !== true, 'BOOTSTRAP_GRANT')
  }
  return grants
}

export function rotateGrants(raw, random = randomBytes) {
  const original = parseGrants(raw)
  const rotated = {}, keyMap = {}
  for (const [oldKey, grant] of Object.entries(original)) {
    const newKey = random(32).toString('base64url')
    ensure(newKey !== oldKey && !Object.hasOwn(rotated, newKey), 'RANDOM_KEY_COLLISION')
    rotated[newKey] = structuredClone(grant)
    keyMap[oldKey] = newKey
  }
  ensure(digest(Object.values(original)) === digest(Object.values(rotated)), 'GRANT_SCOPE_DRIFT')
  return { old: original, rotated, keyMap, raw: JSON.stringify(rotated) }
}

function networkRecord(inspect, { allowBlankId = false } = {}) {
  const entries = Object.entries(inspect.NetworkSettings?.Networks ?? {})
  ensure(entries.length === 2, 'EXPECTED_TWO_NETWORKS')
  return entries.map(([name, endpoint]) => {
    ensure(typeof name === 'string' && name.length > 0 && plain(endpoint), 'INVALID_NETWORK')
    ensure(typeof endpoint.NetworkID === 'string' && (allowBlankId || endpoint.NetworkID.length > 0), 'MISSING_NETWORK_ID')
    ensure(Array.isArray(endpoint.Aliases) && endpoint.Aliases.every(x => typeof x === 'string'), 'MISSING_ALIASES')
    return { name, id: endpoint.NetworkID, aliases: [...endpoint.Aliases].sort(), ipam: endpoint.IPAMConfig ?? null, links: endpoint.Links ?? null, driverOpts: endpoint.DriverOpts ?? null }
  }).sort((a, b) => a.name.localeCompare(b.name))
}

export function snapshotReplica(inspect, expectedRaw) {
  ensure(fullId(inspect?.Id) && /^sha256:[a-f0-9]{64}$/.test(inspect.Image), 'INVALID_CONTAINER_IDENTITY')
  ensure(inspect.State?.Running === true, 'REPLICA_NOT_RUNNING')
  ensure(plain(inspect.Config) && plain(inspect.HostConfig), 'INVALID_CONTAINER_CONFIG')
  ensure(typeof inspect.Name === 'string' && /^\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(inspect.Name), 'INVALID_CONTAINER_NAME')
  ensure(inspect.HostConfig.NetworkMode !== 'host' && inspect.HostConfig.NetworkMode !== 'none' && !String(inspect.HostConfig.NetworkMode).startsWith('container:'), 'UNSUPPORTED_NETWORK_MODE')
  const actual = envValue(inspect.Config.Env, 'API_AUTH_TOKENS')
  // Compare only hashes, with constant-time equality, and never include source in an exception.
  const expectedHash = createHash('sha256').update(expectedRaw).digest()
  const actualHash = createHash('sha256').update(actual).digest()
  ensure(timingSafeEqual(expectedHash, actualHash), 'AUTH_SOURCE_MISMATCH')
  const oldKeys = Object.keys(parseGrants(actual))
  for (const value of inspect.Config.Env) {
    if (value.startsWith('API_AUTH_TOKENS=')) continue
    ensure(!oldKeys.some(key => value.includes(key)), 'OLD_TOKEN_REFERENCED_BY_OTHER_ENV')
  }
  const networks = networkRecord(inspect)
  ensure(networks.some(x => x.name === inspect.HostConfig.NetworkMode || x.id === inspect.HostConfig.NetworkMode), 'PRIMARY_NETWORK_MISSING')
  ensure(Array.isArray(inspect.Mounts), 'MOUNTS_MISSING')
  for (const mount of inspect.Mounts) ensure(['bind', 'volume', 'tmpfs'].includes(mount.Type) && typeof mount.Destination === 'string', 'UNSUPPORTED_MOUNT')
  return {
    id: inspect.Id, name: inspect.Name.slice(1), image: inspect.Image,
    config: structuredClone(inspect.Config), hostConfig: structuredClone(inspect.HostConfig),
    networks, mounts: structuredClone(inspect.Mounts),
    fingerprint: digest({ image: inspect.Image, config: inspect.Config, hostConfig: inspect.HostConfig, networks, mounts: inspect.Mounts }),
  }
}

export function cloneSpec(snapshot, rotatedRaw) {
  const config = structuredClone(snapshot.config)
  config.Image = snapshot.image // Pin the exact immutable image, never a mutable tag.
  config.Env = config.Env.map(value => value.startsWith('API_AUTH_TOKENS=') ? `API_AUTH_TOKENS=${rotatedRaw}` : value)
  const hostConfig = structuredClone(snapshot.hostConfig)
  const primary = snapshot.networks.find(x => x.name === hostConfig.NetworkMode || x.id === hostConfig.NetworkMode)
  ensure(primary, 'PRIMARY_NETWORK_MISSING')
  const endpoint = x => ({ Aliases: x.aliases, IPAMConfig: x.ipam, Links: x.links, DriverOpts: x.driverOpts })
  return {
    Image: snapshot.image, Config: config, HostConfig: hostConfig,
    NetworkingConfig: { EndpointsConfig: { [primary.name]: endpoint(primary) } },
    secondary: snapshot.networks.filter(x => x !== primary).map(x => ({ name: x.name, endpoint: endpoint(x) })),
  }
}

export function validateClone(snapshot, live, rotatedRaw, { running = false } = {}) {
  ensure(live?.Image === snapshot.image && live.State?.Running === running, 'CLONE_IMAGE_OR_STATE_DRIFT')
  const expectedConfig = structuredClone(snapshot.config)
  expectedConfig.Image = snapshot.image
  expectedConfig.Env = expectedConfig.Env.map(value => value.startsWith('API_AUTH_TOKENS=') ? `API_AUTH_TOKENS=${rotatedRaw}` : value)
  ensure(digest(live.Config) === digest(expectedConfig), 'CLONE_CONFIG_DRIFT')
  ensure(digest(normalizedHostConfig(live.HostConfig)) === digest(normalizedHostConfig(snapshot.hostConfig)), 'CLONE_HOST_CONFIG_DRIFT')
  ensure(digest(live.Mounts) === digest(snapshot.mounts), 'CLONE_MOUNT_DRIFT')
  const actualNetworks = networkRecord(live, { allowBlankId: !running })
  for (const expected of snapshot.networks) {
    const found = actualNetworks.find(network => network.name === expected.name)
    ensure(found && (found.id === expected.id || (!running && found.id === '')) && expected.aliases.every(alias => found.aliases.includes(alias)), 'CLONE_NETWORK_DRIFT')
  }
}

export async function preflightEngineClone(engine, plan) {
  for (let i = 0; i < plan.snapshots.length; i++) {
    const snapshot = plan.snapshots[i], spec = plan.specs[i]
    const probeName = `${snapshot.name}-rotation-probe-${snapshot.id.slice(0, 8)}`
    let id
    try {
      id = await engine.create(probeName, spec)
      for (const network of spec.secondary) await engine.connect(id, network.name, network.endpoint)
      for (const network of snapshot.networks) {
        const liveNetwork = await engine.inspectNetwork(network.name)
        ensure(liveNetwork?.Id === network.id, 'CLONE_NETWORK_ID_DRIFT')
      }
      validateClone(snapshot, await engine.inspect(id), plan.rotation.raw)
    } finally {
      if (id) await engine.remove(id)
    }
  }
}

export function publicPlan(inspects, raw, random = randomBytes) {
  ensure(Array.isArray(inspects) && inspects.length === 2, 'EXPECTED_TWO_REPLICAS')
  const rotation = rotateGrants(raw, random)
  const snapshots = inspects.map(x => snapshotReplica(x, raw))
  ensure(new Set(snapshots.map(x => x.id)).size === 2 && new Set(snapshots.map(x => x.name)).size === 2, 'DUPLICATE_REPLICA')
  const specs = snapshots.map(x => cloneSpec(x, rotation.raw))
  for (const [index, spec] of specs.entries()) {
    ensure(spec.Image === snapshots[index].image, 'IMAGE_DRIFT')
    ensure(digest(spec.HostConfig) === digest(snapshots[index].hostConfig), 'HOST_CONFIG_DRIFT')
    ensure(digest(spec.Config.Healthcheck) === digest(snapshots[index].config.Healthcheck), 'HEALTHCHECK_DRIFT')
    ensure(digest(spec.Config.Volumes) === digest(snapshots[index].config.Volumes), 'VOLUME_CONFIG_DRIFT')
    ensure(spec.secondary.length === 1, 'SECONDARY_NETWORK_MISSING')
  }
  return {
    report: { schema_version: 1, mode: 'dry_run', replica_count: 2, grant_count: Object.keys(rotation.rotated).length,
      replicas: snapshots.map(x => ({ name: x.name, id: x.id, image: x.image, fingerprint: x.fingerprint,
        networks: x.networks.map(n => ({ name: n.name, id: n.id, alias_count: n.aliases.length })), mount_count: x.mounts.length,
        healthcheck_present: Boolean(x.config.Healthcheck), restart_policy: x.hostConfig.RestartPolicy?.Name ?? null })) },
    snapshots, specs, rotation,
  }
}

// The adapter is intentionally injected. The caller must prove its Docker
// create/connect/inspect implementation against an isolated clone before
// connecting this state machine to a live Engine socket.
export async function rotateReplicaPair(adapter, plan) {
  ensure(plan?.snapshots?.length === 2 && plan?.specs?.length === 2 && plan?.rotation?.raw, 'INVALID_ROTATION_PLAN')
  const original = plan.snapshots
  const healthy = []
  let recovered = false
  const requireCurrent = async snapshot => {
    const live = await adapter.inspect(snapshot.id)
    const current = snapshotReplica(live, envValue(snapshot.config.Env, 'API_AUTH_TOKENS'))
    ensure(current.fingerprint === snapshot.fingerprint && current.name === snapshot.name, 'LIVE_CONTAINER_DRIFT')
  }
  for (const snapshot of original) await requireCurrent(snapshot)
  const createRotated = async (snapshot, spec) => {
    const id = await adapter.create(snapshot.name, spec)
    try {
      for (const network of spec.secondary) await adapter.connect(id, network.name, network.endpoint)
      await adapter.start(id)
      await adapter.waitHealthy(id)
      const live = await adapter.inspect(id)
      ensure(live?.State?.Running === true && live.State.Health?.Status === 'healthy', 'NEW_REPLICA_UNHEALTHY')
      ensure(live.Image === snapshot.image && live.Name === `/${snapshot.name}`, 'NEW_REPLICA_IDENTITY_DRIFT')
      validateClone(snapshot, live, plan.rotation.raw, { running: true })
      return id
    } catch {
      await adapter.stop(id).catch(() => undefined)
      await adapter.remove(id)
      fail('NEW_REPLICA_CUTOVER_FAILED')
    }
  }
  for (let i = 0; i < original.length; i++) {
    const snapshot = original[i], spec = plan.specs[i]
    let stopped = false, retired = false
    try {
      await adapter.disableRestart(snapshot.id)
      await adapter.stop(snapshot.id)
      stopped = true
      await adapter.rename(snapshot.id, `${snapshot.name}-retired-${snapshot.id.slice(0, 12)}`)
      retired = true
      healthy.push(await createRotated(snapshot, spec))
    } catch {
      if (!stopped) fail('ROTATION_FAILED_BEFORE_CUTOVER')
      // Recover this replica only. The other replica stays healthy throughout.
      try {
        if (!retired) await adapter.rename(snapshot.id, `${snapshot.name}-retired-${snapshot.id.slice(0, 12)}`)
        healthy.push(await createRotated(snapshot, spec))
        recovered = true
      } catch { fail('ROTATION_AND_RECOVERY_FAILED') }
    }
  }
  return { status: recovered ? 'recovered_with_rotated_credentials' : 'rotated', old_containers_stopped: original.length, new_containers_healthy: healthy.length }
}

// A public gateway with one upstream cannot safely use rotateReplicaPair:
// prepare both replacement containers *before* retiring either old container.
// This state machine deliberately accepts an injected gateway/source adapter;
// the production CLI stays closed until their atomicity is proven on host 101.
export function greenSpec(snapshot, rotatedRaw, name) {
  ensure(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) && name !== snapshot.name, 'INVALID_GREEN_NAME')
  ensure(snapshot.config.Healthcheck, 'GREEN_HEALTHCHECK_REQUIRED')
  ensure(snapshot.mounts.every(mount => mount.Type === 'tmpfs' || mount.RW === false), 'WRITABLE_SHARED_MOUNT')
  const spec = cloneSpec(snapshot, rotatedRaw)
  spec.Config.Labels = Object.fromEntries(Object.entries(spec.Config.Labels ?? {}).filter(([key]) => !key.startsWith('com.docker.compose.')))
  spec.HostConfig.PortBindings = {}
  spec.HostConfig.PublishAllPorts = false
  spec.HostConfig.RestartPolicy = { Name: 'no' }
  for (const endpoint of Object.values(spec.NetworkingConfig.EndpointsConfig)) endpoint.Aliases = [name]
  for (const network of spec.secondary) network.endpoint.Aliases = [name]
  return spec
}

export async function rotateWithGateway({ engine, gateway, source, plan, expectedGatewaySha256, publicReplicaName }) {
  ensure(plan?.snapshots?.length === 2 && plan?.rotation?.raw && typeof expectedGatewaySha256 === 'string' && /^[a-f0-9]{64}$/.test(expectedGatewaySha256), 'INVALID_GATEWAY_ROTATION_PLAN')
  ensure(typeof publicReplicaName === 'string' && plan.snapshots.some(x => x.name === publicReplicaName), 'PUBLIC_REPLICA_NOT_IDENTIFIED')
  ensure(engine && gateway && source && typeof gateway.read === 'function' && typeof gateway.install === 'function' && typeof gateway.verify === 'function' && typeof source.persist === 'function', 'ROTATION_ADAPTER_MISSING')
  const old = plan.snapshots
  for (const snapshot of old) {
    const live = snapshotReplica(await engine.inspect(snapshot.id), envValue(snapshot.config.Env, 'API_AUTH_TOKENS'))
    ensure(live.fingerprint === snapshot.fingerprint, 'LIVE_CONTAINER_DRIFT')
  }
  const gatewayBefore = await gateway.read()
  ensure(typeof gatewayBefore === 'string' && createHash('sha256').update(gatewayBefore).digest('hex') === expectedGatewaySha256, 'GATEWAY_CONFIG_DRIFT')
  const { rewriteApiUpstream } = await import('./gateway-upstream-handoff.mjs')
  const green = []
  let handoffAttempted = false
  try {
    for (const snapshot of old) {
      const name = `${snapshot.name}-rotated-${snapshot.id.slice(0, 12)}`
      const spec = greenSpec(snapshot, plan.rotation.raw, name)
      const id = await engine.create(name, spec)
      green.push({ id, name, snapshot })
      for (const network of spec.secondary) await engine.connect(id, network.name, network.endpoint)
      await engine.start(id)
      await engine.waitHealthy(id)
      const live = await engine.inspect(id)
      ensure(live?.Id === id && live.Name === `/${name}` && live.Image === snapshot.image && live.State?.Running === true && live.State.Health?.Status === 'healthy', 'GREEN_IDENTITY_OR_HEALTH_DRIFT')
      ensure(envValue(live.Config?.Env, 'API_AUTH_TOKENS') === plan.rotation.raw, 'GREEN_AUTH_DRIFT')
      ensure(!Object.keys(plan.rotation.old).some(key => JSON.stringify(live.Config?.Env).includes(key)), 'GREEN_OLD_KEY_PRESENT')
      ensure(!live.HostConfig?.PortBindings || Object.keys(live.HostConfig.PortBindings).length === 0, 'GREEN_PUBLIC_PORT_BINDING')
      ensure(live.Mounts?.every(mount => mount.Type === 'tmpfs' || mount.RW === false), 'GREEN_WRITABLE_MOUNT')
    }
    const target = green.find(x => x.snapshot.name === publicReplicaName)
    const rewritten = rewriteApiUpstream(gatewayBefore, publicReplicaName, target.name)
    // Persist the rotated Compose/source mapping before switching traffic, so
    // any subsequent restart cannot reintroduce compromised grants.
    ensure(await source.persist(plan.rotation) === true, 'ROTATED_SOURCE_NOT_PERSISTED')
    // Once installation is attempted, its result may be ambiguous (for
    // example, reload succeeded but the acknowledgement was lost). Keep the
    // greens alive even if install throws or returns false.
    handoffAttempted = true
    ensure(await gateway.install({ expectedSha256: rewritten.before_sha256, config: rewritten.config, nextSha256: rewritten.after_sha256 }) === true, 'GATEWAY_INSTALL_FAILED')
    ensure(await gateway.verify({ target: target.name, rotated: plan.rotation, old: plan.rotation.old }) === true, 'PUBLIC_ROTATED_AUTH_NOT_VERIFIED')
    ensure(createHash('sha256').update(await gateway.read()).digest('hex') === rewritten.after_sha256, 'GATEWAY_POST_SWITCH_DRIFT')
    for (const snapshot of old) {
      await engine.disableRestart(snapshot.id)
      await engine.stop(snapshot.id)
    }
    return { status: 'rotated_gateway', old_containers_stopped: old.length, new_containers_healthy: green.length, public_upstream: target.name }
  } catch {
    if (handoffAttempted) fail('POST_SWITCH_MANUAL_RECOVERY_ROTATED_ONLY')
    // Before a gateway switch the old public path is still live. Remove only
    // our newly created containers; never restart an old compromised one.
    for (const candidate of green.reverse()) {
      await engine.stop(candidate.id).catch(() => undefined)
      await engine.remove(candidate.id).catch(() => undefined)
    }
    fail('PRE_SWITCH_ROTATION_ABORTED')
  }
}

function readProtected(path) {
  ensure(isAbsolute(path) && resolve(path) === path && realpathSync(path) === path, 'INVALID_INPUT_PATH')
  const stat = lstatSync(path)
  ensure(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o7777) === 0o600, 'UNPROTECTED_INPUT')
  return readFileSync(path, 'utf8').trimEnd()
}

export function writeProtectedRotation(path, rotation) {
  ensure(isAbsolute(path) && resolve(path) === path, 'INVALID_OUTPUT_PATH')
  const dir = lstatSync(dirname(path))
  ensure(dir.isDirectory() && !dir.isSymbolicLink() && realpathSync(dirname(path)) === dirname(path) && dir.uid === process.getuid() && (dir.mode & 0o077) === 0, 'UNPROTECTED_OUTPUT_DIRECTORY')
  ensure(plain(rotation?.keyMap) && plain(rotation?.rotated), 'INVALID_ROTATION_OUTPUT')
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify({ schema_version: 1, generated_at: new Date().toISOString(), old_to_new: rotation.keyMap, api_auth_tokens: rotation.rotated })}\n`)
    fsyncSync(fd)
  } finally { closeSync(fd) }
}

export async function executeAgainstEngine() {
  // The public gateway currently has a single API upstream. Stopping that
  // replica during a sequential replacement would interrupt production.
  // A reviewed dual-upstream handoff must be implemented before this path opens.
  fail('PUBLIC_UPSTREAM_HANDOFF_NOT_PROVEN')
}

export function main(argv = process.argv.slice(2)) {
  if (argv[0] === '--dry-run') {
    ensure(argv.length === 4 && argv[1] === '--inspect-json' && argv[3]?.startsWith('--grants-file='), 'USAGE')
    let inspects
    try { inspects = JSON.parse(readProtected(argv[2])) } catch { fail('INVALID_INSPECT_JSON') }
    const raw = readProtected(argv[3].slice('--grants-file='.length))
    const plan = publicPlan(inspects, raw)
    process.stdout.write(`${JSON.stringify(plan.report)}\n`)
    return
  }
  ensure(argv.length === 6 && argv[0] === '--execute' && argv[1] === '--container-ids' && argv[3]?.startsWith('--grants-file=') && argv[4] === '--output-file', 'USAGE')
  return executeAgainstEngine()
    .then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
}

if (process.argv[1] && basename(process.argv[1]) === basename(new URL(import.meta.url).pathname)) {
  Promise.resolve().then(() => main()).catch(error => {
    process.stderr.write(`rotation failed: ${error?.message?.match(/^[A-Z_]+$/)?.[0] ?? 'UNEXPECTED_FAILURE'}\n`)
    process.exitCode = 1
  })
}
