import { execFileSync } from "node:child_process"
import { describe, expect, it } from "vitest"

const compose = ["compose", "-p", "local", "-f", "infra/local/docker-compose.yml"]

function docker(args: string[]) {
  return execFileSync("docker", args, { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

describe("local creative-point seed runtime contract", () => {
  it("keeps ws_demo balance authoritative and known for scanner admission", () => {
    const row = docker([
      ...compose,
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
      "SELECT available_points, reserved_points, settled_points, revision FROM creative_point_access_state WHERE workspace_id='ws_demo'",
    ])

    const [availablePoints, reservedPoints, settledPoints, revision] = row.split("\t")
    expect({ availablePoints, reservedPoints, settledPoints, revision }).toEqual({
      availablePoints: expect.stringMatching(/^[1-9][0-9]*$/),
      reservedPoints: "0",
      settledPoints: "0",
      revision: "1",
    })
  }, 15_000)
})
