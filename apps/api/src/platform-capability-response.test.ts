import { describe, expect, it } from "vitest"
import { projectPlatformCapabilityEvidence, type PlatformMediaSpecEvidence } from "./platform-capability-response.js"

const capabilities = [
  { capability: "media_upload", state: "production_canary" },
  { capability: "read", state: "production_canary" },
] as const

const approved: PlatformMediaSpecEvidence = {
  platform: "taobao",
  device: "desktop",
  version: "media-v3",
  sourceUrl: "https://seller.example/media-spec",
  checkedAt: "2026-08-30T00:00:00.000Z",
  evidenceArtifactRef: "artifact://media-v3",
  status: "approved",
  expiresAt: "2027-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
}

describe("platform capability response projection", () => {
  it("projects only approved desktop media evidence into media_upload", () => {
    expect(projectPlatformCapabilityEvidence(capabilities, [approved], "taobao")).toEqual([
      {
        capability: "media_upload",
        state: "production_canary",
        source: "https://seller.example/media-spec",
        version: "media-v3",
        expiresAt: "2027-08-30T00:00:00.000Z",
        status: "approved",
        verifiedAt: "2026-08-30T00:00:00.000Z",
        evidenceRef: "artifact://media-v3",
      },
      { capability: "read", state: "production_canary" },
    ])
  })

  it("does not manufacture readiness when the media specification is absent or not approved", () => {
    const draft = { ...approved, status: "draft" as const, updatedAt: "2026-08-31T00:00:00.000Z" }
    const mobile = { ...approved, device: "mobile" as const, updatedAt: "2026-09-01T00:00:00.000Z" }
    expect(projectPlatformCapabilityEvidence(capabilities, [draft, mobile], "taobao")).toEqual(capabilities)
    expect(projectPlatformCapabilityEvidence(capabilities, [approved], "jd")).toEqual(capabilities)
  })
})
