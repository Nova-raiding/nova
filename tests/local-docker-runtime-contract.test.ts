import { execFileSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const composeFile = "infra/local/docker-compose.yml"
const project = ["compose", "-p", "local", "-f", composeFile]

type ComposeContainer = {
  Service?: string
  State?: string
  Health?: string
  ID?: string
}

type DockerHealth = {
  Status?: string
  Log?: Array<{ ExitCode?: number; Output?: string }>
}

function docker(args: string[], input?: string) {
  return execFileSync("docker", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  }).trim()
}

function composeContainers() {
  return docker([...project, "ps", "--format", "json"])
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ComposeContainer)
}

function composeLogs(service: string) {
  return docker([...project, "logs", "--no-log-prefix", "--tail", "200", service])
}

const expectedServices = [
  "api",
  "api-replica",
  "clamav",
  "ops-ui",
  "postgres",
  "redis",
  "ui",
  "worker-automation",
  "worker-generation",
  "worker-publish",
  "worker-reconcile",
  "worker-scan",
  "worker-sync",
]

describe("local Docker runtime contract", () => {
  it("keeps every required API, replica, worker and dependency container healthy", () => {
    const containers = composeContainers()
    const byService = new Map(containers.map((container) => [container.Service, container]))

    for (const service of expectedServices) {
      const container = byService.get(service)
      expect(container, `${service} must be running in local Docker`).toBeDefined()
      expect(container?.State, `${service} must be running`).toBe("running")
      expect(container?.Health, `${service} must report Docker health`).toBe("healthy")
    }
  }, 15_000)

  it("records immutable image identity and start-time evidence for every runtime container", () => {
    const containers = composeContainers()
    const byService = new Map(containers.map((container) => [container.Service, container]))

    for (const service of expectedServices) {
      const id = byService.get(service)?.ID
      expect(id, `${service} must expose a container id`).toMatch(/^[0-9a-f]{12,64}$/u)
      const evidence = JSON.parse(docker(["inspect", "--format", "{{json .}}", id!])) as {
        Image?: string
        State?: { Status?: string; StartedAt?: string }
      }
      expect(evidence.Image, `${service} must expose an immutable image id`).toMatch(/^sha256:[0-9a-f]{64}$/u)
      expect(evidence.State?.Status, `${service} must have runtime state evidence`).toBe("running")
      expect(Date.parse(evidence.State?.StartedAt ?? ""), `${service} must expose a valid start time`).toBeGreaterThan(0)
    }
  }, 15_000)

  it("proves worker health checks and heartbeat evidence come from live containers", () => {
    const workerServices = [
      "worker-automation",
      "worker-generation",
      "worker-publish",
      "worker-reconcile",
      "worker-sync",
    ]
    const containers = composeContainers()
    const byService = new Map(containers.map((container) => [container.Service, container]))

    for (const service of [...workerServices, "worker-scan"]) {
      const id = byService.get(service)?.ID
      expect(id, `${service} must expose a container id`).toBeTruthy()
      const health = JSON.parse(docker(["inspect", "--format", "{{json .State.Health}}", id!])) as DockerHealth
      expect(health.Status, `${service} Docker health`).toBe("healthy")
      expect(health.Log?.length, `${service} must retain health evidence`).toBeGreaterThan(0)
      expect(health.Log?.slice(-3).every((entry) => entry.ExitCode === 0), `${service} latest health checks`).toBe(true)
    }

    for (const service of workerServices) {
      const logs = composeLogs(service)
      expect(logs, `${service} must emit live worker evidence`).toContain('"service":"worker"')
      expect(logs, `${service} must emit a worker loop outcome`).toMatch(/"message":"worker poll completed"|"message":"automation workspace maintenance failed; continuing"/u)
    }
    expect(composeLogs("worker-scan"), "worker-scan must emit live heartbeat evidence").toContain('"message":"scanner heartbeat published"')

    const heartbeatKey = docker([...project, "exec", "-T", "redis", "redis-cli", "--raw", "ZRANGE", "merchant:scanner:heartbeats:v1", "-1", "-1"])
    expect(heartbeatKey, "scanner heartbeat index must contain a live instance").toMatch(/^merchant:scanner:heartbeats:v1:[A-Za-z0-9._:-]{1,160}$/u)
    const heartbeat = JSON.parse(docker([...project, "exec", "-T", "redis", "redis-cli", "--raw", "GET", heartbeatKey])) as {
      schemaVersion?: string
      instanceId?: string
      observedAt?: string
      expiresAt?: string
      recoveryCapable?: boolean
    }
    expect(heartbeat).toMatchObject({ schemaVersion: "scanner-heartbeat/1.0", recoveryCapable: true })
    expect(heartbeatKey).toBe(`merchant:scanner:heartbeats:v1:${heartbeat.instanceId}`)
    expect(Date.parse(heartbeat.observedAt ?? "")).toBeGreaterThan(Date.now() - 30_000)
    expect(Date.parse(heartbeat.expiresAt ?? "")).toBeGreaterThan(Date.now())
  }, 15_000)

  it("proves API and replica use durable Postgres persistence and the complete migration tail", () => {
    const config = JSON.parse(docker([...project, "config", "--format", "json"])) as {
      services: Record<string, { environment?: Record<string, string> }>
    }
    for (const service of ["api", "api-replica"]) {
      expect(config.services[service]?.environment?.PERSISTENCE_MODE, `${service} must not use in-memory state`).toBe("postgres")
      expect(config.services[service]?.environment?.DATABASE_URL, `${service} must have a database`).toContain("postgres:")
    }

    const migrationsDir = join(process.cwd(), "packages/persistence/src/migrations")
    const versions = readdirSync(migrationsDir)
      .map((name) => /^(\d+)_.*\.sql$/.exec(name)?.[1])
      .filter((version): version is string => version !== undefined)
      .map(Number)
      .sort((left, right) => left - right)
    const sourceTail = versions.at(-1)
    expect(sourceTail).toBeDefined()

    const databaseTail = docker([
      ...project,
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "merchant",
      "-d",
      "merchant",
      "-Atqc",
      "SELECT count(*)::int || ':' || min(version)::int || ':' || max(version)::int FROM schema_migrations",
    ])
    const [count, minimum, maximum] = databaseTail.split(":").map(Number)
    expect({ count, minimum, maximum }).toEqual({
      count: sourceTail,
      minimum: 1,
      maximum: sourceTail,
    })

    const orphanLeaseSchema = docker([
      ...project,
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "merchant",
      "-d",
      "merchant",
      "-Atqc",
      "SELECT (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='object_storage_orphans' AND column_name IN ('lease_token', 'lease_until'))::int || ':' || (SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='object_storage_orphans_claim_idx')::int",
    ])
    expect(orphanLeaseSchema).toBe("2:1")
  }, 15_000)

  it("refreshes scanner callback evidence through a real local scan", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const body = Buffer.from(`\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDRlocal-callback-${suffix}`, "binary")
    const upload = await fetch("http://127.0.0.1:8787/v1/assets/upload", {
      method: "POST",
      headers: {
        Authorization: "Bearer workspace-local-token",
        "content-type": "image/png",
        "x-workspace-id": "ws_demo",
        "x-asset-name": `scanner-callback-${suffix}.png`,
      },
      body,
    })
    const uploaded = await upload.json() as { data?: { id?: string; scanStatus?: string }; error?: { code?: string } }
    expect(upload.status, JSON.stringify(uploaded)).toBe(201)
    expect(uploaded.error).toBeNull()
    expect(uploaded.data).toMatchObject({ id: expect.any(String), scanStatus: "quarantined" })

    const assetId = uploaded.data!.id!
    const deadline = Date.now() + 30_000
    let callback: { callback_status: string; callback_accepted_at: string | null } | undefined
    while (Date.now() < deadline) {
      const rows = docker([
        ...project,
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "merchant",
        "-d",
        "merchant",
        "-At",
        "-F",
        "\t",
        "-c",
        `SELECT callback_status, COALESCE(callback_accepted_at::text, '') FROM asset_scan_attempts WHERE workspace_id='ws_demo' AND outbox_event_id IN (SELECT id FROM outbox_events WHERE workspace_id='ws_demo' AND aggregate_id='${assetId}') ORDER BY created_at DESC LIMIT 1`,
      ])
      const [status, acceptedAt] = rows.split("\t")
      if (status) {
        callback = { callback_status: status, callback_accepted_at: acceptedAt || null }
        if (status === "accepted") break
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }

    expect(callback, `scanner callback was not recorded for ${assetId}`).toMatchObject({ callback_status: "accepted" })
    expect(Date.parse(callback!.callback_accepted_at!)).toBeGreaterThan(Date.now() - 30_000)

    const scanner = composeContainers().find((container) => container.Service === "worker-scan")
    expect(scanner?.State).toBe("running")
    expect(scanner?.Health).toBe("healthy")
  }, 45_000)

})
