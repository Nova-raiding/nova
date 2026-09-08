import { execFileSync } from "node:child_process"
import { beforeEach, describe, expect, it } from "vitest"
import { requireIsolatedLocalRuntime, type LocalRuntimeTestContext } from './local-runtime-test-safety.js'

let runtime: LocalRuntimeTestContext
beforeEach(() => { runtime = requireIsolatedLocalRuntime() })

function docker(args: string[]) {
  return execFileSync("docker", [...runtime.dockerArgs, ...args], { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

describe("local creative-point seed runtime contract", () => {
  it("keeps the isolated workspace balance authoritative and known for scanner admission", () => {
    const row = docker([
      ...runtime.composeArgs,
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
      `SELECT available_points, reserved_points, settled_points, revision FROM creative_point_access_state WHERE workspace_id='${runtime.workspaceId}'`,
    ])

    const [availablePoints, reservedPoints, settledPoints, revision] = row.split("\t")
    expect({ availablePoints, reservedPoints, settledPoints, revision }).toEqual({
      availablePoints: expect.stringMatching(/^[1-9][0-9]*$/),
      reservedPoints: "0",
      settledPoints: "0",
      // The API seeds the authoritative row after persistence initialization;
      // a second idempotent seed advances the revision while preserving the
      // balance values this contract cares about.
      revision: expect.stringMatching(/^[1-9][0-9]*$/),
    })
  }, 15_000)
})
