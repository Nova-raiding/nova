import { createHash, generateKeyPairSync } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildReleaseManifest } from '../scripts/release-manifest.js'
import { releaseGitShaForRoot } from '../scripts/release-identity.js'
import { signProductionEvidence } from './production-evidence-gate.js'
import { signManualCandidate } from '../infra/protected/attest-manual-operations-evidence.mjs'
import { validateReleaseManifest } from './release-manifest-gate.js'
import { manualCaptureJournal, manualCaptureJournalSha256 } from './manual-operations-evidence-fixture.js'

const evidenceFields = ['capability', 'capacity', 'modelRelay', 'payment', 'restore', 'objectStorage', 'codexAppHost', 'canonicalCutover'] as const
const inputNames = { capability: 'capabilityEvidenceRef', capacity: 'capacityEvidenceRef', modelRelay: 'modelRelayEvidenceRef', payment: 'paymentEvidenceRef', restore: 'restoreEvidenceRef', objectStorage: 'objectStorageEvidenceRef', codexAppHost: 'codexAppHostEvidenceRef', canonicalCutover: 'canonicalCutoverEvidenceRef' } as const
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

const fixtureReleaseId = (() => {
  const root = process.cwd()
  if (existsSync(join(root, '.git'))) return 'release-1'
  const identity = readFileSync(join(root, '.candidate-identity'), 'utf8')
  const releaseId = identity.match(/^release_id=([^\n]+)$/mu)?.[1]
  if (!releaseId || !releaseGitShaForRoot(root, releaseId)) throw new Error('test source has no valid Git HEAD or bound staged candidate identity')
  return releaseId
})()

function boundManifestFixture() {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'release-manifest-evidence-'))
  const pair = generateKeyPairSync('ed25519')
  const privateKeyPem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  const publicKeyPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const evidenceFiles = {} as Record<typeof evidenceFields[number], string>
  const refs = {} as Record<string, string>
  mkdirSync(join(artifactRoot, 'evidence'))
  for (const field of evidenceFields) {
    const document: Record<string, unknown> = { schema_version: '2', release_id: fixtureReleaseId, generated_at: '2026-08-29T00:00:00Z', expires_at: '2026-09-02T00:00:00Z', key_id: 'release-security-test', environment: 'production', status: 'pass' }
    if (field === 'codexAppHost') {
      document.environment = 'preproduction'
      document.manifest_sha256 = '9'.repeat(64)
      document.candidate_route = { expected_git_sha: releaseGitShaForRoot(process.cwd(), fixtureReleaseId), expected_manifest_sha256: '9'.repeat(64), expected_image_set_digest: `sha256:${'a'.repeat(64)}`, candidate_api_container_id: 'b'.repeat(64), gateway_container_id: 'c'.repeat(64), mcp_config_sha256: 'd'.repeat(64), route_file_sha256: 'e'.repeat(64), release_probe_evidence_ref: `artifact://production/evidence/probe.json#${'f'.repeat(64)}` }
    }
    if (field === 'capability' || field === 'payment' || field === 'restore' || field === 'objectStorage' || field === 'codexAppHost') document.signature_base64 = signProductionEvidence(document, privateKeyPem)
    const contents = JSON.stringify(document)
    const path = join(artifactRoot, 'evidence', `${field}.json`)
    writeFileSync(path, contents)
    evidenceFiles[field] = path
    refs[inputNames[field]] = `artifact://production/evidence/${field}.json#${digest(contents)}`
  }
  const manifest = buildReleaseManifest({ root: process.cwd(), releaseId: fixtureReleaseId, generatedAt: '2026-08-29T01:00:00Z', ...refs })
  const options = { root: process.cwd(), expectedReleaseId: fixtureReleaseId, candidateManifestSha256: '9'.repeat(64), artifactRoot, evidenceFiles, publicKeyPem, trustedKeyId: 'release-security-test', now: new Date('2026-08-29T02:00:00Z') }
  return { artifactRoot, evidenceFiles, manifest, options, privateKeyPem }
}

function stagedManifestFixture() {
  const fixture = boundManifestFixture()
  const stagedRoot = mkdtempSync(join(tmpdir(), 'staged-release-manifest-'))
  for (const artifact of fixture.manifest.artifacts) {
    const target = join(stagedRoot, artifact.path)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(process.cwd(), artifact.path), target)
  }
  for (const path of ['scripts/collect-codex-app-host-evidence.mjs', 'tests/codex-app-host-evidence-gate.ts', 'tests/release-manifest-gate.ts', 'docs/runbooks/chatgpt-candidate-host-route.md', 'docs/runbooks/ecs-verified-compose-deploy.md']) {
    const target = join(stagedRoot, path)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(process.cwd(), path), target)
  }
  const navigation = 'apps/ops-console/src/navigation/opsNavigation.ts'
  mkdirSync(dirname(join(stagedRoot, navigation)), { recursive: true })
  copyFileSync(join(process.cwd(), navigation), join(stagedRoot, navigation))
  const identityPath = join(stagedRoot, '.candidate-identity')
  writeFileSync(identityPath, [
    `release_id=${fixtureReleaseId}`,
    `git_sha=${fixture.manifest.components.releaseGitSha}`,
    `source_sha256=sha256:${'a'.repeat(64)}`,
    `comparison_manifest_sha256=sha256:${'b'.repeat(64)}`,
    `sync_plan_sha256=sha256:${'c'.repeat(64)}`,
    '',
  ].join('\n'))
  return { ...fixture, stagedRoot, identityPath }
}

describe('release manifest production gate', () => {
  it('accepts a verified staged source without .git using its candidate identity', () => {
    const fixture = stagedManifestFixture()
    expect(validateReleaseManifest(fixture.manifest, { ...fixture.options, root: fixture.stagedRoot })).toEqual([])
    const previous = process.env.RELEASE_GIT_SHA
    process.env.RELEASE_GIT_SHA = ''
    try {
      const generated = buildReleaseManifest({ root: fixture.stagedRoot, releaseId: fixtureReleaseId })
      expect(generated.components.releaseGitSha).toBe(fixture.manifest.components.releaseGitSha)
    } finally {
      if (previous === undefined) delete process.env.RELEASE_GIT_SHA
      else process.env.RELEASE_GIT_SHA = previous
    }
  })

  it('manifest gate accepts signed candidate ChatGPT evidence and rejects mismatched identities', () => {
    const fixture = boundManifestFixture()
    expect(validateReleaseManifest(fixture.manifest, fixture.options)).toEqual([])
    const hostPath = fixture.evidenceFiles.codexAppHost
    const host = JSON.parse(readFileSync(hostPath, 'utf8')) as Record<string, unknown>
    delete host.signature_base64
    host.candidate_route = { ...(host.candidate_route as object), expected_git_sha: 'c'.repeat(40) }
    delete host.signature_base64
    host.signature_base64 = signProductionEvidence(host, fixture.privateKeyPem)
    const mismatchedHost = JSON.stringify(host)
    writeFileSync(hostPath, mismatchedHost)
    fixture.manifest.productionEvidence!.codexAppHost = `artifact://production/evidence/codexAppHost.json#${digest(mismatchedHost)}`
    expect(validateReleaseManifest(fixture.manifest, fixture.options)).toContain('productionEvidence.codexAppHost candidate Git SHA must match the release manifest')

    host.candidate_route = undefined
    delete host.signature_base64
    host.signature_base64 = signProductionEvidence(host, fixture.privateKeyPem)
    const missingRouteHost = JSON.stringify(host)
    writeFileSync(hostPath, missingRouteHost)
    fixture.manifest.productionEvidence!.codexAppHost = `artifact://production/evidence/codexAppHost.json#${digest(missingRouteHost)}`
    expect(validateReleaseManifest(fixture.manifest, fixture.options)).toContain('productionEvidence.codexAppHost candidate_route is required')
  })

  it('rejects signed ChatGPT candidate evidence bound to another rendered deployment manifest', () => {
    const fixture = boundManifestFixture()
    const host = JSON.parse(readFileSync(fixture.evidenceFiles.codexAppHost, 'utf8')) as Record<string, any>
    delete host.signature_base64
    host.manifest_sha256 = '8'.repeat(64)
    host.candidate_route.expected_manifest_sha256 = '8'.repeat(64)
    host.signature_base64 = signProductionEvidence(host, fixture.privateKeyPem)
    const bytes = JSON.stringify(host)
    writeFileSync(fixture.evidenceFiles.codexAppHost, bytes)
    fixture.manifest.productionEvidence!.codexAppHost = `artifact://production/evidence/codexAppHost.json#${digest(bytes)}`
    expect(validateReleaseManifest(fixture.manifest, fixture.options)).toContain('productionEvidence.codexAppHost candidate manifest SHA must match the deployment binding')
  })

  it('rejects a staged identity with the wrong release, duplicate Git SHA, or invalid Git SHA', () => {
    const fixture = stagedManifestFixture()
    for (const lines of [
      [`release_id=release-other`, `git_sha=${fixture.manifest.components.releaseGitSha}`],
      [`release_id=${fixtureReleaseId}`, `git_sha=${fixture.manifest.components.releaseGitSha}`, `git_sha=${fixture.manifest.components.releaseGitSha}`],
      [`release_id=${fixtureReleaseId}`, 'git_sha=invalid'],
    ]) {
      writeFileSync(fixture.identityPath, `${lines.join('\n')}\n`)
      expect(validateReleaseManifest(fixture.manifest, { ...fixture.options, root: fixture.stagedRoot })).toContain('components.releaseGitSha must match the current Git HEAD or staged candidate identity')
    }
  })

  it('binds API/OpenAPI, MCP and plugin source to one release', () => {
    const manifest = buildReleaseManifest({ root: process.cwd(), releaseId: fixtureReleaseId, capabilityEvidenceRef: 'artifact://production/evidence/capability#' + 'a'.repeat(64), capacityEvidenceRef: 'artifact://production/evidence/capacity#' + 'a'.repeat(64), modelRelayEvidenceRef: 'artifact://production/evidence/relay#' + 'a'.repeat(64), paymentEvidenceRef: 'artifact://production/evidence/payment#' + 'a'.repeat(64), restoreEvidenceRef: 'artifact://production/evidence/restore#' + 'a'.repeat(64), objectStorageEvidenceRef: 'artifact://production/evidence/storage#' + 'a'.repeat(64), codexAppHostEvidenceRef: 'artifact://production/evidence/codex-host#' + 'a'.repeat(64), canonicalCutoverEvidenceRef: 'artifact://production/evidence/canonical-cutover#' + 'a'.repeat(64) })
    expect(validateReleaseManifest(manifest, { root: process.cwd(), expectedReleaseId: fixtureReleaseId })).toEqual([])
  })
  it('rejects stale API/MCP artifacts and unbound production evidence', () => {
    const manifest = buildReleaseManifest({ root: process.cwd(), releaseId: fixtureReleaseId })
    delete (manifest as Partial<typeof manifest>).productionEvidenceBundle
    manifest.artifacts.find(item => item.path === 'apps/api/openapi.yaml')!.sha256 = 'f'.repeat(64)
    expect(validateReleaseManifest(manifest, { root: process.cwd(), expectedReleaseId: fixtureReleaseId })).toEqual(expect.arrayContaining(['productionEvidenceBundle must require release-evidence-bundle/1', 'artifact SHA-256 does not match current source: apps/api/openapi.yaml', 'productionEvidence.capability must be an immutable production artifact']))
    expect(readFileSync('apps/api/openapi.yaml', 'utf8').length).toBeGreaterThan(0)
  })
  it('binds every payment-gateway source and build artifact to the release', () => {
    const gatewayArtifacts = [
      'services/payment-gateway/index.mjs',
      'services/payment-gateway/alipay.mjs',
      'services/payment-gateway/alipay.d.mts',
      'packages/billing/src/callback-envelope.mjs',
      'packages/billing/src/callback-envelope.d.mts',
      'services/payment-gateway/Dockerfile',
    ]
    const manifest = buildReleaseManifest({ root: process.cwd(), releaseId: fixtureReleaseId })
    expect(manifest.artifacts.map(item => item.path)).toEqual(expect.arrayContaining(gatewayArtifacts))
    for (const path of gatewayArtifacts) {
      const tampered = buildReleaseManifest({ root: process.cwd(), releaseId: fixtureReleaseId })
      tampered.artifacts.find(item => item.path === path)!.sha256 = 'f'.repeat(64)
      expect(validateReleaseManifest(tampered, { root: process.cwd(), expectedReleaseId: fixtureReleaseId })).toContain(`artifact SHA-256 does not match current source: ${path}`)
    }
  })
  it('binds the ECS deploy, rollback, render and evidence-bundle trust chain', () => {
    const deploymentArtifacts = [
      'infra/scripts/render-ecs-production-compose.sh',
      'infra/scripts/deploy-verified-ecs-compose.sh',
      'infra/scripts/deploy-preflight-ecs.sh',
      'infra/scripts/stage-verified-ecs-release.sh',
      'infra/scripts/ecs-build-lock.sh',
      'infra/scripts/install-ecs-staging-toolchain.mjs',
      'infra/scripts/build-ecs-release-images.sh',
      'infra/scripts/verify-ecs-ops-auth-mode.sh',
      'infra/scripts/rollback-ecs-compose.sh',
      'infra/scripts/invoke-ecs-automatic-rollback.sh',
      'infra/scripts/install-ecs-release-controls.mjs',
      'infra/scripts/install-ecs-release-controls.d.mts',
      'tests/ecs-staging-toolchain-installer.test.mjs',
      'tests/ecs-staging-toolchain-installer.container-check.mjs',
      'tests/ecs-one-click-deploy.test.ts',
      'docs/runbooks/ecs-candidate-safe-sync.md',
      'infra/protected/attest-release-evidence-bundle.mjs',
      'infra/protected/attest-release-evidence-bundle.d.mts',
      'infra/protected/attest-manual-operations-evidence.mjs',
      'infra/protected/attest-manual-operations-evidence.d.mts',
      'infra/protected/attest-postgres-backup.mjs',
      'infra/protected/attest-postgres-backup.d.mts',
      'infra/protected/ecs-preidentity-recovery.mjs',
      'infra/protected/ecs-preidentity-recovery.d.mts',
      'tests/release-evidence-bundle-gate.ts',
      'infra/protected/ecs-bridge-b-transition.mjs',
      'infra/protected/ecs-bridge-b-transition.d.mts',
      'infra/protected/ecs-bridge-b-journal-store.mjs',
      'infra/protected/ecs-bridge-b-journal-store.d.mts',
      'tests/ecs-bridge-b-transition.test.ts',
      'tests/run-ecs-bridge-b-host-cli.sh',
      'tests/fixtures/ecs-bridge-b-host-cli/curl.mjs',
      'tests/fixtures/ecs-bridge-b-host-cli/docker.mjs',
      'tests/fixtures/ecs-bridge-b-host-cli/nonce-consumer.mjs',
      'tests/fixtures/ecs-bridge-b-host-cli/psql.mjs',
      'tests/fixtures/ecs-bridge-b-host-cli/run.mjs',
      'tests/fixtures/ecs-bridge-b-host-cli/setup.mjs',
      'apps/worker/src/scanner-container-healthcheck.ts',
      'apps/worker/src/scanner-container-healthcheck.test.ts',
      'infra/docker/pilot-gateway-https.Dockerfile',
      'infra/nginx/pilot-gateway-https.conf',
      'infra/scripts/launch-ecs-candidate-tls-gateway.mjs',
      'infra/scripts/launch-ecs-candidate-tls-gateway.d.mts',
      'infra/scripts/launch-ecs-candidate-full-https-gateway.mjs',
      'infra/scripts/launch-ecs-candidate-full-https-gateway.d.mts',
      'infra/scripts/ecs-external-gateway-handoff.mjs',
      'infra/scripts/ecs-external-gateway-handoff.d.mts',
      'tests/ecs-candidate-tls-gateway.test.ts',
      'tests/ecs-candidate-full-https-gateway.test.ts',
      'tests/ecs-external-gateway-handoff.test.ts',
    ]
    const manifest = buildReleaseManifest({ root: process.cwd(), releaseId: fixtureReleaseId })
    expect(manifest.artifacts.map(item => item.path)).toEqual(expect.arrayContaining(deploymentArtifacts))
    for (const path of deploymentArtifacts) {
      const tampered = structuredClone(manifest)
      tampered.artifacts.find(item => item.path === path)!.sha256 = 'f'.repeat(64)
      expect(validateReleaseManifest(tampered, { root: process.cwd(), expectedReleaseId: fixtureReleaseId })).toContain(`artifact SHA-256 does not match current source: ${path}`)
    }
  }, 30_000)
  it('rejects a stale bridge digest or missing marketplace mirror', () => {
    const manifest = buildReleaseManifest({ root: process.cwd(), releaseId: fixtureReleaseId, capabilityEvidenceRef: 'artifact://production/evidence/capability#' + 'a'.repeat(64), capacityEvidenceRef: 'artifact://production/evidence/capacity#' + 'a'.repeat(64), modelRelayEvidenceRef: 'artifact://production/evidence/relay#' + 'a'.repeat(64), paymentEvidenceRef: 'artifact://production/evidence/payment#' + 'a'.repeat(64), restoreEvidenceRef: 'artifact://production/evidence/restore#' + 'a'.repeat(64), objectStorageEvidenceRef: 'artifact://production/evidence/storage#' + 'a'.repeat(64), codexAppHostEvidenceRef: 'artifact://production/evidence/codex-host#' + 'a'.repeat(64), canonicalCutoverEvidenceRef: 'artifact://production/evidence/canonical-cutover#' + 'a'.repeat(64) })
    manifest.mcp!.bridgeSha256 = 'f'.repeat(64)
    manifest.artifacts = manifest.artifacts.filter(item => item.path !== '.codex-marketplace/plugins/merchant-marketing/mcp/bridge.mjs')
    expect(validateReleaseManifest(manifest, { root: process.cwd(), expectedReleaseId: fixtureReleaseId })).toEqual(expect.arrayContaining(['mcp.bridgeSha256 does not match the current source bridge', 'artifact is missing: .codex-marketplace/plugins/merchant-marketing/mcp/bridge.mjs']))
  })

  it('rejects duplicate artifact paths instead of silently overwriting one entry', () => {
    const manifest = buildReleaseManifest({ root: process.cwd(), releaseId: fixtureReleaseId })
    const artifact = manifest.artifacts.find(item => item.path === 'VERSION')!
    manifest.artifacts.push({ ...artifact, sha256: 'f'.repeat(64) })
    expect(validateReleaseManifest(manifest, { root: process.cwd(), expectedReleaseId: fixtureReleaseId })).toContain('artifact path is duplicated: VERSION')
  })

  it('binds the exact evidence bytes, freshness and existing production signatures without creating a production key', () => {
    const fixture = boundManifestFixture()
    expect(validateReleaseManifest(fixture.manifest, fixture.options)).toEqual([])

    const stale = boundManifestFixture()
    expect(validateReleaseManifest(stale.manifest, { ...stale.options, now: new Date('2026-09-10T02:00:00Z') })).toEqual(expect.arrayContaining(['generatedAt is stale', 'productionEvidence.capacity generated timestamp is stale']))

    writeFileSync(fixture.evidenceFiles.capacity, JSON.stringify({ release_id: fixtureReleaseId, generated_at: '2026-08-29T00:00:00Z' }))
    expect(validateReleaseManifest(fixture.manifest, fixture.options)).toContain('productionEvidence.capacity SHA-256 does not match the referenced artifact')

    const swapped = boundManifestFixture()
    expect(validateReleaseManifest(swapped.manifest, { ...swapped.options, evidenceFiles: { ...swapped.evidenceFiles, capacity: swapped.evidenceFiles.modelRelay } })).toContain('productionEvidence.capacity must reference the exact evidence file passed to deployment')

    const expired = boundManifestFixture()
    const expiredDocument = JSON.parse(readFileSync(expired.evidenceFiles.objectStorage, 'utf8')) as Record<string, unknown>
    expiredDocument.expires_at = '2026-08-29T01:30:00Z'
    const expiredContents = JSON.stringify(expiredDocument)
    writeFileSync(expired.evidenceFiles.objectStorage, expiredContents)
    expired.manifest.productionEvidence.objectStorage = `artifact://production/evidence/objectStorage.json#${digest(expiredContents)}`
    expect(validateReleaseManifest(expired.manifest, expired.options)).toContain('productionEvidence.objectStorage has expired')

    const unsigned = boundManifestFixture()
    const capability = JSON.parse(readFileSync(unsigned.evidenceFiles.capability, 'utf8')) as Record<string, unknown>
    delete capability.signature_base64
    const unsignedContents = JSON.stringify(capability)
    writeFileSync(unsigned.evidenceFiles.capability, unsignedContents)
    unsigned.manifest.productionEvidence.capability = `artifact://production/evidence/capability.json#${digest(unsignedContents)}`
    expect(validateReleaseManifest(unsigned.manifest, unsigned.options)).toContain('productionEvidence.capability signature_base64 must be a canonical Ed25519 signature')

    const unsignedHost = boundManifestFixture()
    const host = JSON.parse(readFileSync(unsignedHost.evidenceFiles.codexAppHost, 'utf8')) as Record<string, unknown>
    delete host.signature_base64
    const unsignedHostContents = JSON.stringify(host)
    writeFileSync(unsignedHost.evidenceFiles.codexAppHost, unsignedHostContents)
    unsignedHost.manifest.productionEvidence.codexAppHost = `artifact://production/evidence/codexAppHost.json#${digest(unsignedHostContents)}`
    expect(validateReleaseManifest(unsignedHost.manifest, unsignedHost.options)).toEqual([])

    const unsignedStorage = boundManifestFixture()
    const storage = JSON.parse(readFileSync(unsignedStorage.evidenceFiles.objectStorage, 'utf8')) as Record<string, unknown>
    delete storage.signature_base64
    const unsignedStorageContents = JSON.stringify(storage)
    writeFileSync(unsignedStorage.evidenceFiles.objectStorage, unsignedStorageContents)
    unsignedStorage.manifest.productionEvidence.objectStorage = `artifact://production/evidence/objectStorage.json#${digest(unsignedStorageContents)}`
    expect(validateReleaseManifest(unsignedStorage.manifest, unsignedStorage.options)).toContain('productionEvidence.objectStorage signature_base64 must be a canonical Ed25519 signature')
  })

  it('validates manual capability workflow semantics as well as the artifact signature', () => {
    const fixture = boundManifestFixture()
    const privatePem = fixture.privateKeyPem
    const publicKeyPem = fixture.options.publicKeyPem
    const candidate = {
      schema_version: 'manual-operations-evidence/1', release_id: fixtureReleaseId, environment: 'production', workflow: 'public_import_manual_publish',
      workspace_id: 'workspace-1', isolation_probe_workspace_id: 'foreign-workspace', manual_publish_report_id: 'report-1',
      official_api_receipt: false, manual_evidence_boundary: 'manual_unverified', manual_publish_state: 'manual_publish_reported', tenant_isolation_verified: true, simulated: false, generated_at: '2026-08-29T00:00:00Z',
      expires_at: '2026-08-30T00:00:00Z', verified_by: 'release-operator',
      capture_journal: manualCaptureJournal({ release_id: fixtureReleaseId, release_git_sha: 'c'.repeat(40), manifest_sha256: 'b'.repeat(64), image_set_digest: `sha256:${'a'.repeat(64)}` }, '2026-08-29T00:00:00Z', { manualPublishReportId: 'report-1' }),
      checks: [
        { name: 'tenant_scope', status: 'pass', observation: 'foreign_workspace_rejected' },
        { name: 'manual_report', status: 'pass', observation: 'human_evidence_boundary_preserved' },
        { name: 'merchant_visibility', status: 'pass', observation: 'expected_report_visible' },
      ],
    }
    Object.assign(candidate, { capture_journal_sha256: manualCaptureJournalSha256(candidate.capture_journal) })
    const signed = signManualCandidate(candidate, { releaseId: fixtureReleaseId, imageSetDigest: `sha256:${'a'.repeat(64)}`, manifestSha256: 'b'.repeat(64), releaseGitSha: 'c'.repeat(40), deploymentNonce: 'n'.repeat(22), keyId: 'release-security-test' }, privatePem, publicKeyPem, new Date('2026-08-29T02:00:00Z'))
    const bytes = JSON.stringify(signed)
    writeFileSync(fixture.evidenceFiles.capability, bytes)
    fixture.manifest.productionEvidence.capability = `artifact://production/evidence/capability.json#${digest(bytes)}`
    expect(validateReleaseManifest(fixture.manifest, { ...fixture.options, publicKeyPem })).toEqual([])
    const invalid = { ...signed, official_api_receipt: true }
    const invalidBytes = JSON.stringify(invalid)
    writeFileSync(fixture.evidenceFiles.capability, invalidBytes)
    fixture.manifest.productionEvidence.capability = `artifact://production/evidence/capability.json#${digest(invalidBytes)}`
    expect(validateReleaseManifest(fixture.manifest, { ...fixture.options, publicKeyPem })).toContain('productionEvidence.capability official_api_receipt must be false')
  })

  it('accepts an explicitly bound no-load capacity artifact without treating it as a capacity pass', () => {
    const fixture = boundManifestFixture()
    writeFileSync(fixture.evidenceFiles.capacity, JSON.stringify({
      schema_version: '1', status: 'not_performed', profile: 'no_load', cloud_gate: false,
      capacity_commitment: 'none', scope: 'no_load', reason: 'load_testing_excluded_by_release_scope',
      release_id: fixtureReleaseId, environment: 'production', target_url: 'https://yxsona.com',
      started_at: '2026-08-29T00:00:00Z', ended_at: '2026-08-29T00:30:00Z',
      expires_at: '2026-09-02T00:00:00Z', generated_at: '2026-08-29T00:30:00Z',
      software_version: fixtureReleaseId, config_version: fixtureReleaseId, data_version: fixtureReleaseId,
      sign_off: { verified_by: 'test', verified_at: '2026-08-29T00:15:00Z' },
    }))
    const manifest = buildReleaseManifest({
      root: process.cwd(), releaseId: fixtureReleaseId,
      capabilityEvidenceRef: fixture.manifest.productionEvidence.capability,
      capacityEvidenceRef: `artifact://production/evidence/capacity#${createHash('sha256').update(readFileSync(fixture.evidenceFiles.capacity)).digest('hex')}`,
      modelRelayEvidenceRef: fixture.manifest.productionEvidence.modelRelay,
      paymentEvidenceRef: fixture.manifest.productionEvidence.payment,
      restoreEvidenceRef: fixture.manifest.productionEvidence.restore,
      objectStorageEvidenceRef: fixture.manifest.productionEvidence.objectStorage,
      codexAppHostEvidenceRef: fixture.manifest.productionEvidence.codexAppHost,
      canonicalCutoverEvidenceRef: fixture.manifest.productionEvidence.canonicalCutover,
    })
    expect(validateReleaseManifest(manifest, fixture.options)).not.toEqual(expect.arrayContaining([
      'capacity no-load evidence profile must be no_load',
      'capacity no-load evidence cloud_gate must be false',
      'capacity no-load evidence capacity_commitment must be none',
    ]))
  })

  it('rejects no-load artifacts that claim pass, enable cloud gate, or omit the no-load contract', () => {
    const fixture = boundManifestFixture()
    const base = {
      schema_version: '1', status: 'not_performed', profile: 'no_load', cloud_gate: false,
      capacity_commitment: 'none', scope: 'no_load', reason: 'load_testing_excluded_by_release_scope',
      release_id: fixtureReleaseId, environment: 'production', target_url: 'https://yxsona.com',
      started_at: '2026-08-29T00:00:00Z', ended_at: '2026-08-29T00:30:00Z', expires_at: '2026-09-02T00:00:00Z',
      software_version: fixtureReleaseId, config_version: fixtureReleaseId, data_version: fixtureReleaseId,
      sign_off: { verified_by: 'test', verified_at: '2026-08-29T00:15:00Z' },
    }
    for (const [field, value, expected] of [
      ['status', 'pass', 'status must be not_performed for no_load evidence'],
      ['cloud_gate', true, 'cloud_gate must be false for no_load evidence'],
      ['capacity_commitment', undefined, 'capacity_commitment must be none'],
    ] as const) {
      const document = { ...base, [field]: value }
      writeFileSync(fixture.evidenceFiles.capacity, JSON.stringify(document))
      const manifest = structuredClone(fixture.manifest)
      manifest.productionEvidence!.capacity = `${fixture.manifest.productionEvidence!.capacity!.replace(/#[a-f0-9]{64}$/u, '')}#${digest(JSON.stringify(document))}`
      const errors = validateReleaseManifest(manifest, fixture.options)
      expect(errors).toContain(expected)
    }
  })
})
