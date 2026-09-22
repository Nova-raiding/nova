#!/usr/bin/env node
// Host-local gateway handoff. No container removal or reconstruction.
import { execFileSync, spawnSync } from 'node:child_process'
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const assert = (ok, message) => { if (!ok) throw new Error(message) }
const hash = value => createHash('sha256').update(value).digest('hex')
const stable = value => JSON.stringify(value)
const identity = value => { const { running, ...rest } = value; return stable(rest) }
const disk = { lstatSync, readFileSync, readdirSync, realpathSync }

export function digestPath(path, fs = disk, mountRoot) {
  const stat = fs.lstatSync(path)
  if (stat.isSymbolicLink()) {
    // Certbot live/*.pem links are valid only inside the same mounted tree.
    assert(mountRoot, 'mount source must not be a symlink')
    const target = fs.realpathSync(path)
    assert(target.startsWith(`${mountRoot}/`) && fs.lstatSync(target).isFile(), 'certificate link must resolve to a file inside the mount')
    return hash(stable({ target: target.slice(mountRoot.length + 1), sha256: hash(fs.readFileSync(target)) }))
  }
  const root = mountRoot ?? fs.realpathSync(path)
  if (stat.isDirectory()) return hash(stable(fs.readdirSync(path).sort().map(name => [name, digestPath(`${path}/${name}`, fs, root)])))
  assert(stat.isFile(), 'mount source must be a regular file or directory')
  return hash(fs.readFileSync(path))
}

export function bindings(x) {
  return Object.entries(x.HostConfig?.PortBindings ?? {}).flatMap(([port, values]) =>
    (values ?? []).map(v => ({ port, host: String(v.HostPort), ip: v.HostIp ?? '' }))
  ).sort((a, b) => stable(a).localeCompare(stable(b)))
}

export function createHandoffCore({ inspect, stop, start, lockProbe, otherRunningPortCheck, fs = disk }) {
  const locked = () => assert(lockProbe() === true, 'deployment lock is not held')
  const record = ({ id, project, service, requiredNetwork }) => {
    assert(/^[0-9a-f]{64}$/.test(id), 'full container ID is required')
    assert(/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project) && service === 'pilot-gateway', 'invalid gateway project or service')
    const x = inspect(id)
    assert(x?.Id === id, 'container ID drifted')
    assert(/^sha256:[0-9a-f]{64}$/.test(x.Image), 'immutable image ID is invalid')
    const labels = x.Config?.Labels ?? {}
    if (requiredNetwork) assert(Object.hasOwn(x.NetworkSettings?.Networks ?? {}, requiredNetwork), 'old gateway must share the candidate API network for recovery')
    const unmanaged = project === 'legacy-unmanaged'
    assert(unmanaged
      ? !Object.hasOwn(labels, 'com.docker.compose.project') && !Object.hasOwn(labels, 'com.docker.compose.service')
      : labels['com.docker.compose.project'] === project && labels['com.docker.compose.service'] === service, 'Compose identity drifted')
    const ports = bindings(x)
    for (const [port, host] of [['8080/tcp', '80'], ['8443/tcp', '443']]) assert(ports.some(v => v.port === port && v.host === host), 'gateway must publish host 80/443')
    const mounts = (x.Mounts ?? []).map(m => {
      assert(m.Type === 'bind' && m.RW === false, 'gateway mounts must be read-only binds')
      return { source: m.Source, destination: m.Destination, content_sha256: digestPath(m.Source, fs) }
    }).sort((a, b) => a.destination.localeCompare(b.destination))
    return {
      schema_version: 1, container_id: id, image_id: x.Image, image: x.Config.Image,
      ownership_mode: unmanaged ? 'legacy-unmanaged' : 'compose',
      compose_project: labels['com.docker.compose.project'] ?? null, compose_service: labels['com.docker.compose.service'] ?? null, ports, mounts,
      networks: Object.entries(x.NetworkSettings?.Networks ?? {}).map(([name, net]) => ({ name, id: net.NetworkID, aliases: [...(net.Aliases ?? [])].sort() })).sort((a, b) => a.name.localeCompare(b.name)),
      // Store only hashes of environment/config and certificate contents.
      config_sha256: hash(stable({ entrypoint: x.Config.Entrypoint, cmd: x.Config.Cmd, env: [...(x.Config.Env ?? [])].sort(), healthcheck: x.Config.Healthcheck, restart: x.HostConfig?.RestartPolicy, network_mode: x.HostConfig?.NetworkMode })),
      running: x.State?.Running === true,
    }
  }
  return {
    snapshot(input) {
      locked()
      assert(!otherRunningPortCheck(input.id), 'another gateway owns host 80/443')
      const value = record(input)
      assert(value.running, 'gateway must be running for snapshot')
      return value
    },
    stopAndRestore({ saved, restore = false, ...input }) {
      locked()
      assert(saved?.schema_version === 1 && saved.running === true, 'invalid gateway snapshot')
      const before = record(input)
      assert(identity(saved) === identity(before), 'live gateway differs from snapshot')
      assert(!otherRunningPortCheck(input.id), 'another gateway owns host 80/443')
      if (restore ? !before.running : before.running) (restore ? start : stop)(input.id)
      const after = record(input)
      assert(identity(saved) === identity(after) && after.running === restore, 'gateway mutation did not reach verified state')
    },
  }
}

export function protectedPath(path, { file = false, privateFile = false } = {}) {
  assert(isAbsolute(path) && resolve(path) === path && realpathSync(path) === path, 'path must be absolute and canonical')
  let cursor = path
  for (;;) {
    const stat = lstatSync(cursor)
    assert(!stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o022) === 0, 'path must be root-owned and protected')
    if (cursor === path) {
      assert(file ? stat.isFile() : stat.isDirectory(), 'invalid protected path type')
      if (privateFile) assert((stat.mode & 0o777) === 0o600, 'snapshot must have mode 600')
    } else assert(stat.isDirectory(), 'invalid protected ancestor')
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
}

function verifyLock(path) {
  protectedPath(path, { file: true })
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const expected = fstatSync(fd), inherited = fstatSync(9)
    assert(inherited.isFile() && inherited.dev === expected.dev && inherited.ino === expected.ino, 'FD9 does not match deployment lock')
  } finally { closeSync(fd) }
  const result = spawnSync('/usr/bin/flock', ['-n', '9'], {
    env: {}, stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 9],
  })
  assert(result.status === 0, 'production mutation lock is unavailable')
  return true
}

function writeSnapshot(path, value) {
  protectedPath(dirname(path))
  const temporary = `${path}.${process.pid}.tmp`
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, `${stable(value)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
  try { linkSync(temporary, path) } finally { unlinkSync(temporary) }
}

export function main(argv = process.argv.slice(2)) {
  const [action, ...rest] = argv, args = {}
  assert(['snapshot', 'stop', 'restore', 'check-ports'].includes(action), 'invalid action')
  const allowed = new Set(['state', 'lock-path', 'container-id', 'project', 'service', 'candidate-project', 'required-network'])
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.slice(2), value = rest[i + 1]
    assert(rest[i]?.startsWith('--') && allowed.has(key), 'unknown argument')
    assert(!Object.hasOwn(args, key), 'duplicate argument')
    assert(value && !value.startsWith('--'), 'argument value is required')
    args[key] = value
  }
  const docker = values => execFileSync('/usr/bin/docker', values, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  const inspect = id => JSON.parse(docker(['inspect', id]))[0]
  const others = (exclude, candidateProject) => docker(['ps', '-q', '--no-trunc']).trim().split(/\s+/).filter(Boolean).some(id => {
    const x = inspect(id)
    return x.Id !== exclude && (!candidateProject || x.Config?.Labels?.['com.docker.compose.project'] !== candidateProject) && bindings(x).some(p => ['80', '443'].includes(p.host))
  })
  if (action === 'check-ports') {
    assert(/^[a-z0-9][a-z0-9_-]{0,62}$/.test(args['candidate-project'] ?? ''), 'candidate project is required')
    assert(!others(undefined, args['candidate-project']), 'external gateway owns host 80/443; reviewed handoff is required')
    return
  }
  for (const key of ['state', 'lock-path', 'container-id', 'project', 'service']) assert(args[key], `${key} is required`)
  assert(isAbsolute(args.state) && resolve(args.state) === args.state, 'state path must be absolute and canonical')
  protectedPath(dirname(args.state))
  const core = createHandoffCore({ inspect, stop: id => docker(['stop', '--time', '30', id]), start: id => docker(['start', id]), lockProbe: () => verifyLock(args['lock-path']), otherRunningPortCheck: id => others(id) })
  const input = { id: args['container-id'], project: args.project, service: args.service, requiredNetwork: args['required-network'] }
  if (action === 'snapshot') writeSnapshot(args.state, core.snapshot(input))
  else {
    protectedPath(args.state, { file: true, privateFile: true })
    core.stopAndRestore({ ...input, saved: JSON.parse(readFileSync(args.state, 'utf8')), restore: action === 'restore' })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main() } catch { console.error('external gateway handoff failed; protected state retained; no container was deleted'); process.exitCode = 1 }
}
