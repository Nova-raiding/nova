import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateManualOperationsEvidence } from './manual-operations-evidence-gate.js'
import type { ManualPublishRecord } from '../packages/application/src/service.js'

const candidateIdentity = {
  release_id: 'release-test',
  release_git_sha: 'a'.repeat(40),
  manifest_sha256: 'b'.repeat(64),
  image_set_digest: `sha256:${'c'.repeat(64)}`,
}
const candidateContainerId = 'e'.repeat(64)
const candidateImageId = `sha256:${'d'.repeat(64)}`
const candidateImageRef = `registry.example.test/api@sha256:${'f'.repeat(64)}`
const actualManualRecord = {
  id: 'report-1', workspaceId: 'target-workspace', taskId: 'task-1', productId: 'product-1', contentVersionId: 'version-1',
  platform: 'taobao', accountId: 'store-1', deliveryBundleHash: '1'.repeat(64), state: 'manual_publish_reported',
  actorId: 'operator-1', publisherId: 'publisher-1', operatedAt: '2026-09-25T10:00:00.000Z', platformContentId: 'item-1',
  evidenceAssetIds: [], idempotencyKey: 'manual-record-1', evidenceBoundary: 'manual_unverified', recordedAt: '2026-09-25T10:00:00.000Z', revision: 1,
} satisfies ManualPublishRecord

function fixture(isolationStatus = '403', releaseIdentity = candidateIdentity, containerImageId = candidateImageId, reportBoundary = 'manual_unverified', reportState = 'manual_publish_reported', isolationError: unknown = { code: 'FORBIDDEN' }, reportOverrides: Record<string, unknown> = {}, newerReportCount = 0) {
  const report = { ...actualManualRecord, evidenceBoundary: reportBoundary, state: reportState, ...reportOverrides }
  const reportJson = JSON.stringify({ result: report })
  const newerReports = Array.from({ length: newerReportCount }, (_, index) => ({ ...actualManualRecord, id: `newer-report-${index}` }))
  const listJson = JSON.stringify({ result: { items: newerReports.length ? newerReports.slice(0, 20) : [actualManualRecord], total: newerReports.length + 1, limit: 20, offset: 0 } })
  const secondPageJson = JSON.stringify({ result: { items: [...newerReports.slice(20), actualManualRecord], total: newerReports.length + 1, limit: 20, offset: 20 } })
  const isolationJson = JSON.stringify({ error: isolationError })
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'manual-evidence-capture-')))
  const bin = join(directory, 'bin')
  mkdirSync(bin)
  const curl = join(bin, 'curl')
  writeFileSync(curl, `#!/bin/sh
set -eu
output= data= workspace= url=
while [ "$#" -gt 0 ]; do
  case "$1" in *"$FAKE_EXPECTED_TOKEN"*) printf leaked >"$FAKE_CURL_ARG_LEAK" ;; esac
  case "$1" in
    --output) output=$2; shift 2 ;;
    --data) data=$2; shift 2 ;;
    -H) case "$2" in
      "x-workspace-id: "*) workspace=\${2#x-workspace-id: } ;;
      @*) header_file=\${2#@}; header_contents=$(cat "$header_file"); case "$header_contents" in *"Bearer $FAKE_EXPECTED_TOKEN"*) ;; *) exit 14 ;; esac; node -e 'if ((require("node:fs").statSync(process.argv[1]).mode & 0o777) !== 0o600) process.exit(1)' "$header_file" || exit 15; printf verified >"$FAKE_AUTH_HEADER_VERIFIED" ;;
    esac; shift 2 ;;
    http*) url=$1; shift ;;
    *) shift ;;
  esac
done
if [ "\${url%/releasez}" != "$url" ]; then
  printf '%s' "$FAKE_RELEASE_PAYLOAD" >"$output"; printf 200; exit
fi
printf '%s' requested >"$FAKE_RPC_SENTINEL"
if [ "$workspace" = foreign-workspace ]; then
  printf '%s' '${isolationJson}' >"$output"; printf '${isolationStatus}'; exit
fi
case "$data" in
  *publish.manual.get*) printf '%s' '${reportJson}' >"$output" ;;
  *'"offset":"20"'*) printf '%s' '${secondPageJson}' >"$output" ;;
  *) printf '%s' '${listJson}' >"$output" ;;
esac
printf 200
`)
  chmodSync(curl, 0o755)
  const output = join(directory, 'manual.json')
  const rpcSentinel = join(directory, 'rpc-sent')
  const docker = join(bin, 'docker')
  const response = (status: number, body: unknown) => JSON.stringify({ status, body: JSON.stringify(body) })
  writeFileSync(docker, `#!/bin/sh
set -eu
[ "$1" = --host ] && [ "$2" = unix:///var/run/docker.sock ] || exit 12
shift 2
case "$1" in
  image) printf '%s' '${candidateImageId}' ;;
  inspect) printf '%s' '${candidateContainerId}|${containerImageId}|true' ;;
  exec)
    input=$(dd bs=131072 count=1 2>/dev/null)
    case "$input" in
      *'/releasez'*) printf '%s' '${response(200, { data: { release: releaseIdentity, ready: true } })}' ;;
      *'foreign-workspace'*) printf '%s' requested >'${rpcSentinel}'; printf '%s' '${response(Number(isolationStatus), { error: isolationError })}' ;;
      *'publish.manual.get'*) printf '%s' requested >'${rpcSentinel}'; printf '%s' '${response(200, { result: report })}' ;;
      *) printf '%s' requested >'${rpcSentinel}'; printf '%s' '${response(200, { result: { items: [actualManualRecord], total: 1, limit: 20, offset: 0 } })}' ;;
    esac ;;
  *) exit 13 ;;
esac
`)
  chmodSync(docker, 0o755)
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, RELEASE_ID: 'release-test',
  PRODUCTION_API_BASE_URL: 'https://production.example.test', PRODUCTION_CANARY_BEARER_TOKEN: 'secret-token',
    FAKE_EXPECTED_TOKEN: 'secret-token', FAKE_AUTH_HEADER_VERIFIED: join(directory, 'auth-header-verified'), FAKE_CURL_ARG_LEAK: join(directory, 'curl-arg-leak'),
    PRODUCTION_CANARY_WORKSPACE_ID: 'target-workspace', PRODUCTION_CANARY_ISOLATION_WORKSPACE_ID: 'foreign-workspace',
    PRODUCTION_MANUAL_REPORT_ID: 'report-1', MANUAL_OPERATIONS_EVIDENCE_OUTPUT: output,
    MANUAL_OPERATIONS_EXPECTED_RELEASE_GIT_SHA: candidateIdentity.release_git_sha,
    MANUAL_OPERATIONS_EXPECTED_MANIFEST_SHA256: candidateIdentity.manifest_sha256,
    MANUAL_OPERATIONS_EXPECTED_IMAGE_SET_DIGEST: candidateIdentity.image_set_digest,
    MANUAL_OPERATIONS_VERIFIED_BY: 'release-operator',
    FAKE_RELEASE_PAYLOAD: JSON.stringify({ data: { release: releaseIdentity, ready: true } }),
    FAKE_RPC_SENTINEL: rpcSentinel,
    MANUAL_OPERATIONS_TEST_DOCKER_BINARY: docker,
    NODE_ENV: 'test', VITEST: 'true',
  }
  return { output, env, rpcSentinel }
}

describe('manual operations evidence capture', () => {
  it('writes tenant- and release-bound evidence only after real response contracts pass', () => {
    const { output, env } = fixture()
    expect(actualManualRecord).toHaveProperty('evidenceBoundary', 'manual_unverified')
    expect(actualManualRecord).toHaveProperty('state', 'manual_publish_reported')
    expect(actualManualRecord).not.toHaveProperty('official_api_receipt')
    execFileSync('sh', ['infra/scripts/capture-manual-operations-evidence.sh'], { env, stdio: 'pipe' })
    const evidence = JSON.parse(readFileSync(output, 'utf8'))
    expect(statSync(output).mode & 0o777).toBe(0o600)
    expect(evidence).toMatchObject({ release_id: 'release-test', workspace_id: 'target-workspace', manual_publish_report_id: 'report-1', manual_evidence_boundary: 'manual_unverified', manual_publish_state: 'manual_publish_reported', simulated: false, tenant_isolation_verified: true })
    expect(evidence.capture_journal).toMatchObject({ schema_version: 'manual-operations-capture-journal/1', candidate_identity: candidateIdentity })
    expect(evidence.capture_journal.observations.map((observation: { name: string; status: number }) => [observation.name, observation.status])).toEqual([
      ['release', 200], ['target_list', 200], ['target_get', 200], ['isolation', 403],
    ])
    expect(evidence.capture_journal.observations.every((observation: { observation_sha256: string; material: object }) => /^[a-f0-9]{64}$/u.test(observation.observation_sha256) && !('response' in observation.material))).toBe(true)
    expect(evidence.capture_journal.observations.map((observation: { name: string; material: object }) => [observation.name, observation.material])).toEqual([
      ['release', { ...candidateIdentity, ready: true }],
      ['target_list', { expected_report_visible: true, visible_report_id: 'report-1', total: 1, returned_count: 1 }],
      ['target_get', { manual_publish_report_id: 'report-1', state: 'manual_publish_reported', evidence_boundary: 'manual_unverified' }],
      ['isolation', { error_envelope: true, code_present: true }],
    ])
    expect(JSON.stringify(evidence)).not.toContain('secret-token')
    expect(existsSync(env.FAKE_AUTH_HEADER_VERIFIED)).toBe(true)
    expect(existsSync(env.FAKE_CURL_ARG_LEAK)).toBe(false)
    expect(validateManualOperationsEvidence(evidence, 'release-test')).toEqual([])
  })

  it('finds an older report on the second tenant-scoped list page', () => {
    const { output, env } = fixture('403', candidateIdentity, candidateImageId, 'manual_unverified', 'manual_publish_reported', { code: 'FORBIDDEN' }, {}, 20)
    execFileSync('sh', ['infra/scripts/capture-manual-operations-evidence.sh'], { env, stdio: 'pipe' })
    const evidence = JSON.parse(readFileSync(output, 'utf8'))
    expect(evidence.capture_journal.observations.find((observation: { name: string }) => observation.name === 'target_list').material).toEqual({
      expected_report_visible: true, visible_report_id: 'report-1', total: 21, returned_count: 1,
    })
    expect(validateManualOperationsEvidence(evidence, 'release-test')).toEqual([])
  })

  it.each([
    ['release_id', { ...candidateIdentity, release_id: 'release-other' }],
    ['Git SHA', { ...candidateIdentity, release_git_sha: 'd'.repeat(40) }],
    ['manifest SHA', { ...candidateIdentity, manifest_sha256: 'e'.repeat(64) }],
    ['image-set digest', { ...candidateIdentity, image_set_digest: `sha256:${'f'.repeat(64)}` }],
  ])('rejects an origin response whose %s differs before sending a bearer request', (_field, observedIdentity) => {
    const { output, env, rpcSentinel } = fixture('403', observedIdentity)
    expect(() => execFileSync('sh', ['infra/scripts/capture-manual-operations-evidence.sh'], { env, stdio: 'pipe' })).toThrow()
    expect(existsSync(rpcSentinel)).toBe(false)
    expect(existsSync(output)).toBe(false)
  })

  it.each(['official_api', 'unknown', ''])('rejects a report without the explicit manual_unverified boundary: %s', boundary => {
    const { output, env } = fixture('403', candidateIdentity, candidateImageId, boundary)
    expect(() => execFileSync('sh', ['infra/scripts/capture-manual-operations-evidence.sh'], { env, stdio: 'pipe' })).toThrow()
    expect(existsSync(output)).toBe(false)
  })

  it('rejects an unrecognized manual report state', () => {
    const { output, env } = fixture('403', candidateIdentity, candidateImageId, 'manual_unverified', 'published')
    expect(() => execFileSync('sh', ['infra/scripts/capture-manual-operations-evidence.sh'], { env, stdio: 'pipe' })).toThrow()
    expect(existsSync(output)).toBe(false)
  })

  it('rejects a manual report that also claims an official API receipt', () => {
    const { output, env } = fixture('403', candidateIdentity, candidateImageId, 'manual_unverified', 'manual_publish_reported', { code: 'FORBIDDEN' }, { official_api_receipt: true })
    expect(() => execFileSync('sh', ['infra/scripts/capture-manual-operations-evidence.sh'], { env, stdio: 'pipe' })).toThrow()
    expect(existsSync(output)).toBe(false)
  })

  it('does not write evidence when the foreign-workspace negative probe succeeds', () => {
    const { output, env } = fixture('200')
    expect(() => execFileSync('sh', ['infra/scripts/capture-manual-operations-evidence.sh'], { env, stdio: 'pipe' })).toThrow()
    expect(() => readFileSync(output)).toThrow()
  })

  it.each([{ label: 'empty error object', error: {} }, { label: 'array error', error: [] }])('rejects a foreign-workspace $label without a non-empty object code', ({ error }) => {
    const { output, env } = fixture('403', candidateIdentity, candidateImageId, 'manual_unverified', 'manual_publish_reported', error)
    expect(() => execFileSync('sh', ['infra/scripts/capture-manual-operations-evidence.sh'], { env, stdio: 'pipe' })).toThrow()
    expect(existsSync(output)).toBe(false)
  })

  it('captures a candidate only through an exact running container with matching image and release identity', () => {
    const { output, env } = fixture()
    delete (env as Partial<typeof env>).PRODUCTION_API_BASE_URL
    Object.assign(env, {
      MANUAL_OPERATIONS_CANDIDATE_CONTAINER_ID: candidateContainerId,
      MANUAL_OPERATIONS_CANDIDATE_API_IMAGE_REF: candidateImageRef,
      MANUAL_OPERATIONS_EXPECTED_RELEASE_GIT_SHA: candidateIdentity.release_git_sha,
      MANUAL_OPERATIONS_EXPECTED_MANIFEST_SHA256: candidateIdentity.manifest_sha256,
      MANUAL_OPERATIONS_EXPECTED_IMAGE_SET_DIGEST: candidateIdentity.image_set_digest,
    })
    execFileSync('sh', ['infra/scripts/capture-manual-operations-evidence.sh'], { env, stdio: 'pipe' })
    const evidence = JSON.parse(readFileSync(output, 'utf8'))
    expect(validateManualOperationsEvidence(evidence, 'release-test')).toEqual([])
    expect(evidence).not.toHaveProperty('signature_base64')
  })

  it('rejects the old release on a candidate endpoint even when the report reads succeed', () => {
    const { output, env, rpcSentinel } = fixture('403', { ...candidateIdentity, release_git_sha: 'd'.repeat(40) })
    Object.assign(env, {
      MANUAL_OPERATIONS_CANDIDATE_CONTAINER_ID: candidateContainerId,
      MANUAL_OPERATIONS_CANDIDATE_API_IMAGE_REF: candidateImageRef,
      MANUAL_OPERATIONS_EXPECTED_RELEASE_GIT_SHA: candidateIdentity.release_git_sha,
      MANUAL_OPERATIONS_EXPECTED_MANIFEST_SHA256: candidateIdentity.manifest_sha256,
      MANUAL_OPERATIONS_EXPECTED_IMAGE_SET_DIGEST: candidateIdentity.image_set_digest,
    })
    expect(() => execFileSync('sh', ['infra/scripts/capture-manual-operations-evidence.sh'], { env, stdio: 'pipe' })).toThrow()
    expect(() => readFileSync(output)).toThrow()
    expect(existsSync(rpcSentinel)).toBe(false)
  })

  it('rejects the retired loopback URL candidate transport before making requests', () => {
    for (const endpoint of ['https://127.0.0.1:18787', 'http://localhost:18787', 'http://0.0.0.0:18787', 'http://127.0.0.1:18787/path']) {
      const { output, env } = fixture()
      Object.assign(env, { MANUAL_OPERATIONS_CANDIDATE_API_BASE_URL: endpoint })
      expect(() => execFileSync('sh', ['infra/scripts/capture-manual-operations-evidence.sh'], { env, stdio: 'pipe' })).toThrow()
      expect(() => readFileSync(output)).toThrow()
    }
  })

  it('rejects a port-squatting listener when the exact candidate container image differs', () => {
    const { output, env, rpcSentinel } = fixture('403', candidateIdentity, `sha256:${'1'.repeat(64)}`)
    Object.assign(env, {
      MANUAL_OPERATIONS_CANDIDATE_CONTAINER_ID: candidateContainerId,
      MANUAL_OPERATIONS_CANDIDATE_API_IMAGE_REF: candidateImageRef,
      MANUAL_OPERATIONS_EXPECTED_RELEASE_GIT_SHA: candidateIdentity.release_git_sha,
      MANUAL_OPERATIONS_EXPECTED_MANIFEST_SHA256: candidateIdentity.manifest_sha256,
      MANUAL_OPERATIONS_EXPECTED_IMAGE_SET_DIGEST: candidateIdentity.image_set_digest,
    })
    expect(() => execFileSync('sh', ['infra/scripts/capture-manual-operations-evidence.sh'], { env, stdio: 'pipe' })).toThrow()
    expect(existsSync(rpcSentinel)).toBe(false)
    expect(existsSync(output)).toBe(false)
  })

  it('rejects Docker binary substitution under production environment', () => {
    const { output, env, rpcSentinel } = fixture()
    Object.assign(env, {
      NODE_ENV: 'production',
      MANUAL_OPERATIONS_CANDIDATE_CONTAINER_ID: candidateContainerId,
      MANUAL_OPERATIONS_CANDIDATE_API_IMAGE_REF: candidateImageRef,
      MANUAL_OPERATIONS_EXPECTED_RELEASE_GIT_SHA: candidateIdentity.release_git_sha,
      MANUAL_OPERATIONS_EXPECTED_MANIFEST_SHA256: candidateIdentity.manifest_sha256,
      MANUAL_OPERATIONS_EXPECTED_IMAGE_SET_DIGEST: candidateIdentity.image_set_digest,
    })
    expect(() => execFileSync('sh', ['infra/scripts/capture-manual-operations-evidence.sh'], { env, stdio: 'pipe' })).toThrow()
    expect(existsSync(rpcSentinel)).toBe(false)
    expect(existsSync(output)).toBe(false)
  })
})
