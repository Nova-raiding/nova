import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateManualOperationsEvidence } from './manual-operations-evidence-gate.js'

const candidateIdentity = {
  release_id: 'release-test',
  release_git_sha: 'a'.repeat(40),
  manifest_sha256: 'b'.repeat(64),
  image_set_digest: `sha256:${'c'.repeat(64)}`,
}
const candidateContainerId = 'e'.repeat(64)
const candidateImageId = `sha256:${'d'.repeat(64)}`
const candidateImageRef = `registry.example.test/api@sha256:${'f'.repeat(64)}`

function fixture(isolationStatus = '403', releaseIdentity = candidateIdentity, containerImageId = candidateImageId) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'manual-evidence-capture-')))
  const bin = join(directory, 'bin')
  mkdirSync(bin)
  const curl = join(bin, 'curl')
  writeFileSync(curl, `#!/bin/sh
set -eu
output= data= workspace= url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output=$2; shift 2 ;;
    --data) data=$2; shift 2 ;;
    -H) case "$2" in "x-workspace-id: "*) workspace=\${2#x-workspace-id: } ;; esac; shift 2 ;;
    http*) url=$1; shift ;;
    *) shift ;;
  esac
done
if [ "\${url%/releasez}" != "$url" ]; then
  printf '%s' "$FAKE_RELEASE_PAYLOAD" >"$output"; printf 200; exit
fi
printf '%s' requested >"$FAKE_RPC_SENTINEL"
if [ "$workspace" = foreign-workspace ]; then
  printf '%s' '{"error":{"code":"FORBIDDEN"}}' >"$output"; printf '${isolationStatus}'; exit
fi
case "$data" in
  *publish.manual.get*) printf '%s' '{"result":{"id":"report-1","state":"manual_publish_reported"}}' >"$output" ;;
  *) printf '%s' '{"result":{"items":[{"id":"report-1","state":"manual_publish_reported"}],"total":1,"limit":20,"offset":0}}' >"$output" ;;
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
      *'foreign-workspace'*) printf '%s' requested >'${rpcSentinel}'; printf '%s' '${response(Number(isolationStatus), { error: { code: 'FORBIDDEN' } })}' ;;
      *'publish.manual.get'*) printf '%s' requested >'${rpcSentinel}'; printf '%s' '${response(200, { result: { id: 'report-1', state: 'manual_publish_reported' } })}' ;;
      *) printf '%s' requested >'${rpcSentinel}'; printf '%s' '${response(200, { result: { items: [{ id: 'report-1', state: 'manual_publish_reported' }], total: 1, limit: 20, offset: 0 } })}' ;;
    esac ;;
  *) exit 13 ;;
esac
`)
  chmodSync(docker, 0o755)
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, RELEASE_ID: 'release-test',
    PRODUCTION_API_BASE_URL: 'https://production.example.test', PRODUCTION_CANARY_BEARER_TOKEN: 'secret-token',
    PRODUCTION_CANARY_WORKSPACE_ID: 'target-workspace', PRODUCTION_CANARY_ISOLATION_WORKSPACE_ID: 'foreign-workspace',
    PRODUCTION_MANUAL_REPORT_ID: 'report-1', MANUAL_OPERATIONS_EVIDENCE_OUTPUT: output,
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
    execFileSync('sh', ['infra/scripts/capture-manual-operations-evidence.sh'], { env, stdio: 'pipe' })
    const evidence = JSON.parse(readFileSync(output, 'utf8'))
    expect(evidence).toMatchObject({ release_id: 'release-test', workspace_id: 'target-workspace', manual_publish_report_id: 'report-1', simulated: false, tenant_isolation_verified: true })
    expect(validateManualOperationsEvidence(evidence, 'release-test')).toEqual([])
  })

  it('does not write evidence when the foreign-workspace negative probe succeeds', () => {
    const { output, env } = fixture('200')
    expect(() => execFileSync('sh', ['infra/scripts/capture-manual-operations-evidence.sh'], { env, stdio: 'pipe' })).toThrow()
    expect(() => readFileSync(output)).toThrow()
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
