// Docker/PG17 ports for the isolated 254→255 restore core. No production
// Compose project, database socket, gateway or existing volume is addressed.
// This is a library for a future fixed-installed root controller, not an
// executable release path. It cannot consume a nonce or switch traffic.
import { createHash, randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createReadStream } from 'node:fs'

const HEX = /^[a-f0-9]{64}$/u
const IMAGE = /^sha256:[a-f0-9]{64}$/u
const ATTEMPT = /^[A-Za-z0-9_-]{16,128}$/u
const fail = reason => { throw new Error(`BRIDGE_255_ISOLATED_HOST_${reason}`) }
const check = (ok, reason) => { if (!ok) fail(reason) }
const sha = value => createHash('sha256').update(value).digest('hex')
const fixedEnv = extra => ({ PATH: '/usr/bin:/bin', HOME: '/nonexistent',
  DOCKER_HOST: 'unix:///var/run/docker.sock', ...extra })

export function isolatedDockerArgs({ attemptId, suffix, imageRef, network, volume, container }) {
  check(ATTEMPT.test(attemptId ?? '') && /^[a-f0-9]{24}$/u.test(suffix ?? '')
    && IMAGE.test(imageRef ?? ''), 'IDENTITY_INVALID')
  check(network === `merchant_restore_net_${suffix}`
    && volume === `merchant_restore_data_${suffix}`
    && container === `merchant_restore_pg_${suffix}`, 'NAMES_NOT_ISOLATED')
  return Object.freeze({
    network: ['network', 'create', '--internal', network],
    volume: ['volume', 'create', volume],
    postgres: ['run', '-d', '--name', container, '--network', network,
      '--mount', `type=volume,source=${volume},target=/var/lib/postgresql/data`,
      '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_DB=merchant', imageRef],
  })
}

function realDocker(args, { input, timeout = 120_000, env = {} } = {}) {
  const result = spawnSync('/usr/bin/docker', args, {
    input, encoding: input ? undefined : 'utf8', timeout, maxBuffer: 128 * 1024,
    env: fixedEnv(env),
  })
  check(!result.error && result.status === 0, `DOCKER_${args[0].toUpperCase()}_FAILED`)
  return String(result.stdout ?? '').trim()
}

function realDockerStream(args, file, timeout = 3_600_000) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/docker', args, { stdio: ['pipe', 'pipe', 'pipe'], env: fixedEnv() })
    const source = createReadStream(file, { flags: 'r' })
    let bytes = 0, failed = false
    const stop = error => { if (failed) return; failed = true; clearTimeout(timer)
      source.destroy(); if (error) { child.kill('SIGKILL'); reject(error) } else resolve() }
    const timer = setTimeout(() => stop(new Error('isolated pg_restore timed out')), timeout)
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 128 * 1024) stop(new Error('isolated Docker output too large')) })
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 128 * 1024) stop(new Error('isolated Docker diagnostic too large')) })
    child.on('error', stop)
    child.stdin.on('error', stop)
    source.on('error', stop)
    child.on('close', code => stop(code === 0 ? null : new Error('isolated pg_restore failed')))
    source.pipe(child.stdin)
  })
}

/** The caller must already have verified the fixed installed root executable. */
export function createIsolatedPg17DockerPorts({ docker = realDocker,
  stream = realDockerStream, random = () => randomBytes(12).toString('hex'),
  wait = ms => new Promise(done => setTimeout(done, ms)) } = {}) {
  const attempts = new Map()
  const held = attemptId => { const attempt = attempts.get(attemptId)
    check(attempt, 'ATTEMPT_NOT_CREATED'); return attempt }
  const query = (attempt, sql) => docker(['exec', '-u', 'postgres', attempt.container,
    'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'merchant',
    '-c', sql])
  return Object.freeze({
    async create({ attemptId, imageRef, preserveVolume, internalNetwork, publishPorts }) {
      check(ATTEMPT.test(attemptId ?? '') && IMAGE.test(imageRef ?? '')
        && preserveVolume === true && internalNetwork === true && publishPorts === false
        && !attempts.has(attemptId), 'CREATE_POLICY_INVALID')
      const suffix = random()
      const network = `merchant_restore_net_${suffix}`,
        volume = `merchant_restore_data_${suffix}`,
        container = `merchant_restore_pg_${suffix}`
      const args = isolatedDockerArgs({ attemptId, suffix, imageRef, network, volume, container })
      const image = JSON.parse(docker(['image', 'inspect', imageRef]))[0]
      check(image?.Id === imageRef, 'PINNED_PG17_IMAGE_MISSING')
      const attempt = { network, volume, container, imageRef,
        password: randomBytes(48).toString('base64url'), networkId: null, containerId: null }
      attempts.set(attemptId, attempt)
      attempt.networkId = docker(args.network)
      check(HEX.test(attempt.networkId), 'NETWORK_ID_INVALID')
      check(docker(args.volume) === volume, 'VOLUME_ID_INVALID')
      attempt.containerId = docker(args.postgres, { env: { POSTGRES_PASSWORD: attempt.password } })
      check(HEX.test(attempt.containerId), 'CONTAINER_ID_INVALID')
      // pg_isready can succeed against the image's temporary initdb server,
      // which then restarts before ordinary queries are accepted. Wait for a
      // real query against the target database before proceeding.
      let version
      for (let tries = 0; tries < 60; tries++) {
        try {
          docker(['exec', '-u', 'postgres', attempt.container, 'pg_isready',
            '-U', 'postgres', '-d', 'merchant'], { timeout: 10_000 })
          version = query(attempt, 'SHOW server_version_num')
          break
        }
        catch (error) { if (tries === 59) throw error; await wait(1000) }
      }
      check(/^17\d{4}$/u.test(version),
        'POSTGRES_17_REQUIRED')
    },
    async inspect(attemptId) {
      const a = held(attemptId)
      check(HEX.test(a.networkId ?? '') && HEX.test(a.containerId ?? ''),
        'PARTIAL_ATTEMPT_QUARANTINE_REQUIRED')
      const network = JSON.parse(docker(['network', 'inspect', a.network]))[0]
      const container = JSON.parse(docker(['inspect', a.container]))[0]
      const volume = JSON.parse(docker(['volume', 'inspect', a.volume]))[0]
      check(network?.Id === a.networkId && network.Internal === true
        && container?.Id === a.containerId && container.Image === a.imageRef
        && container.Config?.Image === a.imageRef
        && container.State?.Running === true
        && Object.keys(container.NetworkSettings?.Networks ?? {}).join() === a.network
        && Object.values(container.NetworkSettings?.Ports ?? {}).every(value => value === null)
        && container.Mounts?.length === 1 && container.Mounts[0].Type === 'volume'
        && container.Mounts[0].Name === a.volume
        && volume?.Name === a.volume, 'DOCKER_INSPECTION_INVALID')
      const dbId = query(a, 'SELECT system_identifier FROM pg_control_system()')
      check(/^\d{1,32}$/u.test(dbId), 'DATABASE_ID_INVALID')
      return { container_id: a.containerId, database_id_sha256: sha(dbId),
        image_id: a.imageRef, network_id: a.networkId, network_internal: true,
        published_ports: [], volume_name: a.volume, volume_preserved: true,
        source_mounted: false }
    },
    async restoreDump({ attemptId, backupPath, backupSha256, readOnlySource }) {
      const a = held(attemptId)
      check(readOnlySource === true && HEX.test(backupSha256 ?? '')
        && typeof backupPath === 'string', 'RESTORE_SOURCE_INVALID')
      docker(['exec', '-i', '-u', 'postgres', a.container, 'psql', '-X',
        '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'merchant'],
      { input: Buffer.from('CREATE ROLE merchant_app LOGIN; CREATE ROLE merchant_ops LOGIN;') })
      await stream(['exec', '-i', '-u', 'postgres', a.container, 'pg_restore', '-U',
        'postgres', '-d', 'merchant', '--exit-on-error', '--no-owner', '--no-privileges'],
      backupPath)
    },
    async readHistory(attemptId) {
      const rows = query(held(attemptId), 'SELECT version, name, checksum FROM public.schema_migrations ORDER BY version')
      return rows ? rows.split('\n').map(line => {
        const columns = line.split('|')
        check(columns.length === 3 && /^\d+$/u.test(columns[0]), 'HISTORY_ROW_MALFORMED')
        return { version: Number(columns[0]), name: columns[1], checksum: columns[2] }
      }) : []
    },
    async applyOnly255({ attemptId, sql, sqlSha256, name, expectedBefore }) {
      const a = held(attemptId)
      check(Buffer.isBuffer(sql) && sha(sql) === sqlSha256 && HEX.test(expectedBefore ?? ''),
        'MIGRATION_ASSET_INVALID')
      check(name === 'scoped_brand_settings', 'MIGRATION_NAME_INVALID')
      // One transaction makes a post-crash 254 or 255 history unambiguous.
      // The complete 254 rowset is checked by the restore core before this.
      const script = Buffer.concat([Buffer.from(`BEGIN;\nSELECT pg_advisory_xact_lock(731942851);\nDO $$ BEGIN IF (SELECT count(*) FROM public.schema_migrations) <> 254 OR (SELECT max(version) FROM public.schema_migrations) <> 254 THEN RAISE EXCEPTION 'prefix changed'; END IF; END $$;\n`),
        sql, Buffer.from(`\nINSERT INTO public.schema_migrations(version,name,checksum) VALUES (255,'${name}','${sqlSha256}');\nCOMMIT;\n`)])
      docker(['exec', '-i', '-u', 'postgres', a.container, 'psql', '-X', '-v',
        'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'merchant'],
      { input: script, timeout: 3_600_000 })
    },
    async quarantineAttempt({ attemptId, preserveVolume, keepInternal }) {
      const a = held(attemptId)
      check(preserveVolume === true && keepInternal === true, 'QUARANTINE_POLICY_INVALID')
      if (a.containerId) docker(['stop', '--time', '3', a.containerId], { timeout: 10_000 })
      // Leave the internal network and isolated volume intact for diagnosis.
    },
  })
}
