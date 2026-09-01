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
  }, 15_000)

})
