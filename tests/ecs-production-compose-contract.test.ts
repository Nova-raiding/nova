import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const nodeHardening = { user: '10001:10001', read_only: true, security_opt: ['no-new-privileges:true'], cap_drop: ['ALL'], tmpfs: ['/tmp'] }
const valid = {
  services: {
    api: { ...nodeHardening, volumes: ['/evidence/capacity.json:/run/release-evidence/capacity-report.json:ro'], environment: {
      NODE_ENV: 'production', DEPLOYMENT_PROFILE: 'ecs', LOCAL_COMPOSE: 'false',
      CONNECTOR_FIXTURE_MODE: 'false', PLATFORM_OPERATIONS_MODE: 'manual', MERCHANT_TEST_APPROVED_RATES: 'false',
      ALLOW_LOCAL_DURABLE_OBJECT_STORAGE: 'false',
      ASSET_STORAGE_CREDENTIAL_PROVIDER: 'aliyun_ecs_ram_role',
      OPS_ALERT_NOTIFICATIONS_ENABLED: 'false',
      ALERT_CHANNEL_SECRET_REF: '', OPS_ALERT_WEBHOOK_URL: '',
      OPS_ALERT_WEBHOOK_ALLOWED_HOSTS: '', OPS_ALERT_WEBHOOK_SECRET_FILE: '',
      API_AUTH_TOKENS: '{"production":{"workspaces":["ws_prod"]}}', SESSION_ID_HASH_SECRET: 'session-secret',
      WORKER_API_CREDENTIALS: JSON.stringify(Object.fromEntries(['sync', 'generation', 'publish', 'reconcile', 'automation', 'scan'].map(role => [role, { token: `worker-${role}-token`, signing_secret: `worker-${role}-signing` }]))),
      ASSET_DISPLAY_URL_SIGNING_SECRET: 'display-secret', ASSET_DISPLAY_URL_SIGNING_KEY_ID: 'display-production',
      ALLOW_WILDCARD_WORKSPACE_GRANT: 'false',
      OPS_LOCAL_SESSION_WORKSPACE_ID: '', DATABASE_URL: 'postgres://app:opaque@db/merchant',
      OPS_DATABASE_URL: 'postgres://ops:opaque@db/merchant', MODEL_COST_ESTIMATE_VERSION: 'production-v1',
      MCP_INTEGRATION_MODE: 'local_stdio', MCP_OAUTH_REQUIRED: 'false',
      CAPACITY_REPORT_PATH: '/run/release-evidence/capacity-report.json',
    } },
    'api-replica': { ...nodeHardening, volumes: ['/evidence/capacity.json:/run/release-evidence/capacity-report.json:ro'], environment: {
      NODE_ENV: 'production', DEPLOYMENT_PROFILE: 'ecs', LOCAL_COMPOSE: 'false',
      CONNECTOR_FIXTURE_MODE: 'false', PLATFORM_OPERATIONS_MODE: 'manual', MERCHANT_TEST_APPROVED_RATES: 'false',
      ALLOW_LOCAL_DURABLE_OBJECT_STORAGE: 'false',
      ASSET_STORAGE_CREDENTIAL_PROVIDER: 'aliyun_ecs_ram_role',
      OPS_ALERT_NOTIFICATIONS_ENABLED: 'false',
      ALERT_CHANNEL_SECRET_REF: '', OPS_ALERT_WEBHOOK_URL: '',
      OPS_ALERT_WEBHOOK_ALLOWED_HOSTS: '', OPS_ALERT_WEBHOOK_SECRET_FILE: '',
      API_AUTH_TOKENS: '{"production":{"workspaces":["ws_prod"]}}', SESSION_ID_HASH_SECRET: 'session-secret',
      WORKER_API_CREDENTIALS: JSON.stringify(Object.fromEntries(['sync', 'generation', 'publish', 'reconcile', 'automation', 'scan'].map(role => [role, { token: `worker-${role}-token`, signing_secret: `worker-${role}-signing` }]))),
      ASSET_DISPLAY_URL_SIGNING_SECRET: 'display-secret', ASSET_DISPLAY_URL_SIGNING_KEY_ID: 'display-production',
      ALLOW_WILDCARD_WORKSPACE_GRANT: 'false',
      OPS_LOCAL_SESSION_WORKSPACE_ID: '', DATABASE_URL: 'postgres://app:opaque@db/merchant',
      OPS_DATABASE_URL: 'postgres://ops:opaque@db/merchant', MODEL_COST_ESTIMATE_VERSION: 'production-v1',
      MCP_INTEGRATION_MODE: 'local_stdio', MCP_OAUTH_REQUIRED: 'false',
      CAPACITY_REPORT_PATH: '/run/release-evidence/capacity-report.json',
    } },
    ...Object.fromEntries(['worker-sync', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-automation', 'worker-scan'].map(name => [name, { ...nodeHardening, environment: {
      NODE_ENV: 'production', DATABASE_URL: 'postgres://app:opaque@db/merchant', WORKER_WORKSPACES: 'auto', WORKER_API_TOKEN: `${name}-token`, WORKER_API_SIGNING_SECRET: `${name}-signing`,
    } }])),
    migrate: {
      entrypoint: ['/bin/sh', '-c', '/bin/sh /ops/apply-migrations.sh && /bin/sh /ops/verify-runtime-db-role.sh'],
      volumes: ['/migrations:/migrations:ro'],
    },
  },
}

function validate(value: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'ecs-production-compose-'))
  const path = join(dir, 'rendered.json')
  writeFileSync(path, JSON.stringify(value))
  return execFileSync('node', ['infra/scripts/validate-ecs-production-compose.mjs', path], {
    cwd: process.cwd(), encoding: 'utf8', stdio: 'pipe',
  })
}

function renderFinalProductionCompose() {
  const files = readFileSync('infra/local/ecs-production-compose.layers', 'utf8').trim().split('\n')
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/\$\{([A-Z0-9_]+):\?[^}]+\}/gu)) {
      const name = match[1]
      if (name) env[name] = 'production-test-value'
    }
  }
  const roles = ['sync', 'generation', 'publish', 'reconcile', 'automation', 'scan'] as const
  type WorkerRole = typeof roles[number]
  type WorkerCredential = { token: string; signing_secret: string }
  const credentials = Object.fromEntries(roles.map(role => [role, { token: `worker-${role}-token`, signing_secret: `worker-${role}-signing` }])) as Record<WorkerRole, WorkerCredential>
  Object.assign(env, {
    API_AUTH_TOKENS: '{"production":{"workspaces":["ws_prod"],"bootstrap":false}}',
    WORKER_API_CREDENTIALS: JSON.stringify(credentials),
    WORKER_WORKSPACES: 'auto',
    MODEL_COST_ESTIMATE_VERSION: 'production-v1',
    DATABASE_URL: 'postgres://app:opaque@postgres:5432/merchant',
    OPS_DATABASE_URL: 'postgres://ops:opaque@postgres:5432/merchant',
    ASSET_STORAGE_SSE_MODE: 'AES256', ASSET_STORAGE_KMS_KEY_ID: '',
    ASSET_STORAGE_ECS_RAM_ROLE: 'production-role',
    ASSET_SCANNER_API_TOKEN: credentials.scan.token,
    ASSET_SCANNER_WORKSPACE_SIGNING_SECRET: credentials.scan.signing_secret,
    CAPABILITY_EVIDENCE_PATH: '/tmp/production-capability-evidence.json',
    CAPACITY_REPORT_PATH: '/tmp/production-capacity-report.json',
    PILOT_GATEWAY_IMAGE_REF: `registry.example/pilot-gateway@sha256:${'a'.repeat(64)}`,
  })
  for (const role of roles.filter(role => role !== 'scan')) {
    env[`WORKER_${role.toUpperCase()}_API_TOKEN`] = credentials[role].token
    env[`WORKER_${role.toUpperCase()}_API_SIGNING_SECRET`] = credentials[role].signing_secret
  }
  return JSON.parse(execFileSync('sh', ['infra/scripts/render-ecs-production-compose.sh'], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...env, ECS_COMPOSE_PROJECT: 'compose-contract-test' }, stdio: ['ignore', 'pipe', 'pipe'],
  }))
}

describe('ECS production Compose contract', () => {
  it('requires an explicit root-owned 0600 env file when the production override is used', () => {
    const renderer = readFileSync('infra/scripts/render-ecs-production-compose.sh', 'utf8')
    expect(renderer).toContain('ECS_PRODUCTION_ENV_FILE must be an absolute path')
    expect(renderer).toContain('ECS_PRODUCTION_ENV_FILE must be a regular non-symlink file')
    expect(renderer).toContain('ECS_PRODUCTION_ENV_FILE must be root-owned with mode 600')
    expect(renderer).toContain('ECS_PRODUCTION_ENV_FILE must be outside the mutable repository')
    expect(renderer).toContain('docker compose -p "$project" --env-file "$production_env"')
    expect(renderer).toContain('unsafe ECS_COMPOSE_PROJECT')
  })

  it('rejects relative and symlink-parent external env paths before Compose', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ecs-production-env-'))
    const envPath = join(dir, 'production.env')
    writeFileSync(envPath, 'NODE_ENV=production\n')
    expect(() => execFileSync('sh', ['infra/scripts/render-ecs-production-compose.sh'], {
      cwd: process.cwd(), env: { ...process.env, ECS_PRODUCTION_ENV_FILE: 'relative.env' }, stdio: 'pipe',
    })).toThrow()

    const targetParent = join(dir, 'target-parent')
    mkdirSync(targetParent)
    writeFileSync(join(targetParent, 'production.env'), 'NODE_ENV=production\n')
    const linkParent = join(dir, 'link-parent')
    symlinkSync(targetParent, linkParent)
    try {
      execFileSync('sh', ['infra/scripts/render-ecs-production-compose.sh'], {
        cwd: process.cwd(), env: { ...process.env, ECS_PRODUCTION_ENV_FILE: join(linkParent, 'production.env') }, stdio: 'pipe',
      })
      throw new Error('expected symlink-parent path to be rejected')
    } catch (error) {
      const stderr = error && typeof error === 'object' && 'stderr' in error ? String((error as { stderr?: Buffer }).stderr ?? '') : ''
      expect(stderr).toContain('must not traverse symlinked or non-canonical parents')
    }
  })

  it('rejects production rendering without the external env before invoking Docker', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', DEPLOYMENT_PROFILE: 'ecs' }
    delete env.ECS_PRODUCTION_ENV_FILE
    try {
      execFileSync('sh', ['infra/scripts/render-ecs-production-compose.sh'], {
        cwd: process.cwd(), env, stdio: 'pipe',
      })
      throw new Error('expected production env requirement')
    } catch (error) {
      const stderr = error && typeof error === 'object' && 'stderr' in error ? String((error as { stderr?: Buffer }).stderr ?? '') : ''
      expect(stderr).toContain('ECS_PRODUCTION_ENV_FILE is required for production Compose rendering')
      expect(stderr).not.toContain('docker compose')
    }
  })

  it('accepts a production render without demo seeding', () => {
    expect(validate(valid)).toContain('contract passed')
  })

  it('accepts the real final six-layer production render and proves demo seed removal', () => {
    const rendered = renderFinalProductionCompose()
    const migrate = rendered.services.migrate
    expect(JSON.stringify(migrate.entrypoint)).not.toContain('seed-demo.sql')
    expect(JSON.stringify(migrate.volumes)).not.toContain('seed-demo.sql')
    const gateway = rendered.services['pilot-gateway']
    expect(rendered.networks.default.name).toBe('compose-contract-test_default')
    expect(Object.values(rendered.volumes).every((volume: any) => volume.name.startsWith('compose-contract-test_'))).toBe(true)
    expect(gateway.image).toBe(`registry.example/pilot-gateway@sha256:${'a'.repeat(64)}`)
    expect(gateway.ports).toEqual(expect.arrayContaining([
      expect.objectContaining({ published: '80', target: 8080 }),
      expect.objectContaining({ published: '443', target: 8443 }),
    ]))
    expect(gateway.volumes).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: '/opt/merchant-deploy/deploy/certs', target: '/etc/nginx/certs', read_only: true }),
    ]))
    expect(validate(rendered)).toContain('contract passed')
  })

  it('renders CPU quantities as strings so the ECS Compose version can read the artifact', () => {
    const rendered = renderFinalProductionCompose()
    for (const service of Object.values(rendered.services) as any[]) {
      for (const resource of [service.deploy?.resources?.limits, service.deploy?.resources?.reservations]) {
        if (resource?.cpus !== undefined) expect(typeof resource.cpus).toBe('string')
      }
      if (service.cpus !== undefined) expect(typeof service.cpus).toBe('string')
    }

    const dir = mkdtempSync(join(tmpdir(), 'ecs-compose-roundtrip-'))
    const path = join(dir, 'rendered.json')
    writeFileSync(path, JSON.stringify(rendered))
    expect(() => execFileSync('docker', ['compose', '-f', path, 'config', '--format', 'json'], {
      cwd: process.cwd(), stdio: 'pipe',
    })).not.toThrow()
  })

  it.each([
    ['NODE_ENV', 'development'],
    ['DEPLOYMENT_PROFILE', 'local_acceptance'],
    ['LOCAL_COMPOSE', 'true'],
    ['CONNECTOR_FIXTURE_MODE', 'true'],
    ['MERCHANT_TEST_APPROVED_RATES', 'true'],
    ['ALLOW_LOCAL_DURABLE_OBJECT_STORAGE', 'true'],
  ])('rejects an auth-hardening style %s=%s override', (key, value) => {
    const rendered = structuredClone(valid)
    ;(rendered.services.api.environment as Record<string, string>)[key] = value
    expect(() => validate(rendered)).toThrow(new RegExp(`api\\.${key}`))
  })

  it('rejects seed-demo in either the command or mounts', () => {
    const command = structuredClone(valid)
    command.services.migrate.entrypoint.push('&& psql -f /ops/seed-demo.sql')
    expect(() => validate(command)).toThrow(/must not execute seed-demo/)

    const mount = structuredClone(valid)
    mount.services.migrate.volumes.push('./seed-demo.sql:/ops/seed-demo.sql:ro')
    expect(() => validate(mount)).toThrow(/must not mount seed-demo/)
  })

  it('rejects Kubernetes credentials and any enabled alert wiring', () => {
    for (const [key, value] of [
      ['ASSET_STORAGE_CREDENTIAL_PROVIDER', 'aliyun_ack_rrsa'],
      ['OPS_ALERT_NOTIFICATIONS_ENABLED', 'true'],
      ['OPS_ALERT_WEBHOOK_URL', 'https://alerts.example.test/hook'],
      ['OPS_ALERT_WEBHOOK_SECRET_FILE', '/run/secrets/alert_receiver_hmac_secret'],
    ] as const) {
      const rendered = structuredClone(valid)
      ;(rendered.services.api.environment as Record<string, string>)[key] = value
      expect(() => validate(rendered)).toThrow(new RegExp(`api\\.${key}`))
    }
  })

  it('rejects alert secret mounts and an always-on alert receiver', () => {
    const mount = structuredClone(valid) as any
    mount.services.api.volumes = ['/host/alert_receiver_hmac_secret:/run/secrets/alert_receiver_hmac_secret:ro']
    expect(() => validate(mount)).toThrow(/must not mount alert receiver secrets/)

    const receiver = structuredClone(valid) as any
    receiver.services['alert-receiver'] = { ...nodeHardening, profiles: [] }
    expect(() => validate(receiver)).toThrow(/isolated behind the alerts profile/)
  })

  it('rejects local bootstrap identities and demo worker credentials', () => {
    const api = structuredClone(valid) as any
    api.services.api.environment.API_AUTH_TOKENS = '{"pilot-local-token":{"workspaces":["*"]}}'
    expect(() => validate(api)).toThrow(/local\/demo production configuration|wildcard workspace grant/)

    const worker = structuredClone(valid) as any
    worker.services['worker-sync'].environment.WORKER_API_TOKEN = 'sync-local-token'
    expect(() => validate(worker)).toThrow(/worker-sync contains a local\/demo identity/)
  })

  it('rejects demo session, local cost metadata, and predictable local database credentials', () => {
    for (const [key, value] of [
      ['OPS_LOCAL_SESSION_WORKSPACE_ID', 'ws_demo'],
      ['MODEL_COST_ESTIMATE_VERSION', 'local-acceptance-2026-09-14'],
      ['DATABASE_URL', 'postgres://merchant_app:merchant_app_local_only@postgres:5432/merchant'],
      ['OPS_DATABASE_URL', 'postgres://merchant_ops:merchant_ops_local_only@postgres:5432/merchant'],
    ] as const) {
      const rendered = structuredClone(valid) as any
      rendered.services.api.environment[key] = value
      expect(() => validate(rendered)).toThrow(/must be empty|local\/demo production configuration/)
    }
  })

  it('rejects bootstrap grants and worker credential sets that are incomplete or do not match injection', () => {
    const bootstrap = structuredClone(valid) as any
    bootstrap.services.api.environment.API_AUTH_TOKENS = '{"opaque":{"workspaces":["ws_prod"],"bootstrap":true}}'
    expect(() => validate(bootstrap)).toThrow(/bootstrap=true/)

    const incomplete = structuredClone(valid) as any
    incomplete.services.api.environment.WORKER_API_CREDENTIALS = '{"sync":{"token":"worker-sync-token","signing_secret":"worker-sync-signing"}}'
    expect(() => validate(incomplete)).toThrow(/exactly the six production worker roles/)

    const mismatch = structuredClone(valid) as any
    const credentials = JSON.parse(mismatch.services.api.environment.WORKER_API_CREDENTIALS)
    credentials.generation.token = 'different-token'
    mismatch.services.api.environment.WORKER_API_CREDENTIALS = JSON.stringify(credentials)
    expect(() => validate(mismatch)).toThrow(/generation.token must match worker-generation/)
  })

  it.each([
    ['privileged mode', (service: any) => { service.privileged = true }, /privileged/],
    ['host networking', (service: any) => { service.network_mode = 'host' }, /network_mode/],
    ['Docker socket access', (service: any) => { service.volumes = ['/var\/run\/docker.sock:/var\/run\/docker.sock'] }, /Docker socket/],
    ['a sensitive host mount', (service: any) => { service.volumes = ['/etc:/host-etc:ro'] }, /sensitive host path/],
  ])('rejects %s for every production service', (_label, mutate, message) => {
    const rendered = structuredClone(valid) as any
    mutate(rendered.services.migrate)
    expect(() => validate(rendered)).toThrow(message)
  })

  it.each([
    ['root identity', (service: any) => { service.user = '0:0' }, /non-root identity/],
    ['writable root filesystem', (service: any) => { service.read_only = false }, /read_only/],
    ['missing no-new-privileges', (service: any) => { service.security_opt = [] }, /no-new-privileges/],
    ['retained Linux capabilities', (service: any) => { service.cap_drop = [] }, /cap_drop/],
  ])('rejects application containers with %s', (_label, mutate, message) => {
    const rendered = structuredClone(valid) as any
    mutate(rendered.services['worker-generation'])
    expect(() => validate(rendered)).toThrow(message)
  })

  it('allows stateful and one-shot infrastructure to keep the filesystem and image entrypoint identity they require', () => {
    const rendered = structuredClone(valid) as any
    rendered.services.postgres = { image: 'postgres:16-alpine', volumes: ['merchant-postgres:/var/lib/postgresql/data'] }
    rendered.services.redis = { image: 'redis:7-alpine', volumes: ['merchant-redis:/data'] }
    expect(validate(rendered)).toContain('contract passed')
  })
})
