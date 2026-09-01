import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const digest = `sha256:${'a'.repeat(64)}`
const imageDigests = {
  'merchant-api': `sha256:${'a'.repeat(64)}`,
  'merchant-worker': `sha256:${'b'.repeat(64)}`,
  'merchant-ui': `sha256:${'c'.repeat(64)}`,
  'merchant-ops-ui': `sha256:${'d'.repeat(64)}`,
  clamav: `sha256:${'e'.repeat(64)}`,
}

function runManifest(manifest: string, digestSpecification = digest, extraArgs: string[] = []) {
  const directory = mkdtempSync(join(tmpdir(), 'merchant-kubernetes-release-gate-'))
  const path = join(directory, 'rendered.yaml')
  writeFileSync(path, manifest)
  return () => {
    const releaseOutput = execFileSync('sh', ['infra/scripts/validate-kubernetes-release.sh', path, digestSpecification, ...extraArgs], { encoding: 'utf8', stdio: 'pipe' })
    if (digestSpecification.startsWith('{') && !extraArgs.includes('--rollback')) {
      execFileSync('ruby', ['infra/kubernetes/validate-scanner-contract.rb', path], { encoding: 'utf8', stdio: 'pipe' })
    }
    return releaseOutput
  }
}

function runScannerContract(manifest: string) {
  const directory = mkdtempSync(join(tmpdir(), 'merchant-scanner-contract-'))
  const path = join(directory, 'rendered.yaml')
  writeFileSync(path, manifest)
  return () => execFileSync('ruby', ['infra/kubernetes/validate-scanner-contract.rb', path], { encoding: 'utf8', stdio: 'pipe' })
}

function deployment(podSpec: string, name = 'merchant-api') {
  return [
    'apiVersion: apps/v1',
    'kind: Deployment',
    `metadata: {name: ${name}}`,
    'spec:',
    '  template:',
    '    spec:',
    ...podSpec.split('\n').map(line => `      ${line}`),
  ].join('\n')
}

function configDigest(name: string, data: Record<string, string>) {
  const canonical = `${name}\n${Object.entries(data).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, value]) => `data.${key}=${value}\n`).join('')}`
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`
}

function deploymentWithConfig(podSpec: string, configName: string, data: Record<string, string>, name = 'merchant-api', annotation = configDigest(configName, data)) {
  return [
    'apiVersion: apps/v1',
    'kind: Deployment',
    `metadata: {name: ${name}}`,
    'spec:',
    '  template:',
    `    metadata: {annotations: {merchant.example.com/config-sha256: "${annotation}"}}`,
    '    spec:',
    ...podSpec.split('\n').map(line => `      ${line}`),
  ].join('\n')
}

function productionWorkerCredentialManifest(sharedPublishToken = false) {
  const secret = (env: string, key: string) => `{name: ${env}, valueFrom: {secretKeyRef: {name: merchant-runtime-secrets, key: ${key}}}}`
  const resources = [deployment(`containers: [{name: api, image: registry.example.com/merchant-api@${digest}, env: [${secret('WORKER_API_CREDENTIALS', 'WORKER_API_CREDENTIALS')}]}]`)]
  for (const role of ['sync', 'generation', 'publish', 'reconcile', 'automation']) {
    const upper = role.toUpperCase()
    const tokenKey = sharedPublishToken && role === 'publish' ? 'WORKER_SYNC_API_TOKEN' : `WORKER_${upper}_API_TOKEN`
    resources.push(deployment(`containers: [{name: worker, image: registry.example.com/merchant-api@${digest}, env: [{name: WORKER_ROLE, value: ${role}}, ${secret('WORKER_API_TOKEN', tokenKey)}, ${secret('WORKER_API_SIGNING_SECRET', `WORKER_${upper}_API_SIGNING_SECRET`)}]}]`, `merchant-worker-${role}`))
  }
  return resources.join('\n---\n')
}

function productionScannerManifest(mutate?: (manifest: Record<string, any>) => void) {
  const runtimeData = {
    MCP_AUTHZ_MODE: 'enforce', AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED: 'true',
    ALLOW_LOCAL_ASSET_SCAN_FIXTURE: 'false', ASSET_SCANNER_MODE: 'clamav_worker', ASSET_SCAN_POLICY_VERSION: 'scan-policy-2026-08-30',
    ASSET_SCANNER_SERVICE_ID: 'merchant-asset-scanner-production', ASSET_SCAN_APPROVED_SCANNER_SERVICE_IDS: 'merchant-asset-scanner-production', ASSET_SCAN_MIN_DEFINITIONS_VERSION: '28000',
    CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: '3310', CLAMAV_MAX_FILE_BYTES: '52428800', CLAMAV_SIGNATURE_MAX_AGE_MINUTES: '1440',
  }
  const secret = (name: string, key = name) => ({ name, valueFrom: { secretKeyRef: { name: 'merchant-scanner-secrets', key } } })
  const runtimeSecret = (name: string, key = name) => ({ name, valueFrom: { secretKeyRef: { name: 'merchant-runtime-secrets', key } } })
  const annotation = { 'merchant.example.com/config-sha256': configDigest('merchant-runtime', runtimeData) }
  const manifest: Record<string, any> = { apiVersion: 'v1', kind: 'List', items: [
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'merchant-runtime' }, data: runtimeData },
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'merchant-api' }, spec: { template: { metadata: { annotations: annotation }, spec: { containers: [{ name: 'api', image: `registry.example.com/merchant-api@${imageDigests['merchant-api']}`, envFrom: [{ configMapRef: { name: 'merchant-runtime' } }], env: [secret('ASSET_SCANNER_API_TOKEN'), secret('ASSET_SCANNER_WORKSPACE_SIGNING_SECRET'), secret('ASSET_SCAN_TRUSTED_PUBLIC_KEYS'), runtimeSecret('MODEL_RELAY_API_KEY'), runtimeSecret('PLATFORM_RULE_SYNC_SIGNING_SECRET'), runtimeSecret('PAYMENT_PROVIDER_API_KEY'), runtimeSecret('PAYMENT_CALLBACK_SECRET')] }] } } } },
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'merchant-worker-scan' }, spec: { replicas: 2, template: { metadata: { annotations: annotation }, spec: { nodeSelector: { 'kubernetes.io/arch': 'amd64' }, containers: [
      { name: 'worker', image: `registry.example.com/merchant-worker@${imageDigests['merchant-worker']}`, envFrom: [{ configMapRef: { name: 'merchant-runtime' } }], env: [
        { name: 'WORKER_ROLE', value: 'scan' }, { name: 'ASSET_SCANNER_SERVICE_ID', valueFrom: { configMapKeyRef: { name: 'merchant-runtime', key: 'ASSET_SCANNER_SERVICE_ID' } } }, { name: 'SCANNER_MINIMUM_READY_INSTANCES', value: '2' }, secret('WORKER_API_TOKEN', 'ASSET_SCANNER_API_TOKEN'), secret('WORKER_API_SIGNING_SECRET', 'ASSET_SCANNER_WORKSPACE_SIGNING_SECRET'), secret('ASSET_SCANNER_API_TOKEN'), secret('ASSET_SCANNER_WORKSPACE_SIGNING_SECRET'), secret('ASSET_SCAN_RECEIPT_KEY_ID'), secret('ASSET_SCAN_RECEIPT_PRIVATE_KEY_PEM'),
      ] },
      { name: 'clamav', image: `registry.example.com/clamav@${imageDigests.clamav}`, startupProbe: { exec: { command: ['sh', '-c', 'clamdscan --ping 1'] } }, readinessProbe: { exec: { command: ['sh', '-c', 'clamdscan --ping 1 && find /var/lib/clamav -mmin -1440'] } }, livenessProbe: { exec: { command: ['sh', '-c', 'clamdscan --ping 1'] } } },
    ] } } } },
    { apiVersion: 'v1', kind: 'Service', metadata: { name: 'merchant-api' }, spec: { selector: { 'app.kubernetes.io/name': 'merchant-api' } } },
    { apiVersion: 'v1', kind: 'Service', metadata: { name: 'merchant-api-scanner-internal' }, spec: { publishNotReadyAddresses: true, selector: { 'app.kubernetes.io/name': 'merchant-api' } } },
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'merchant-ui' }, spec: { template: { spec: { containers: [{ name: 'ui', image: `registry.example.com/merchant-ui@${imageDigests['merchant-ui']}` }] } } } },
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'merchant-ops-ui' }, spec: { template: { spec: { containers: [{ name: 'ops-ui', image: `registry.example.com/merchant-ops-ui@${imageDigests['merchant-ops-ui']}` }] } } } },
  ] }
  mutate?.(manifest)
  const currentRuntime = manifest.items.find((item: any) => item.kind === 'ConfigMap' && item.metadata?.name === 'merchant-runtime')?.data
  if (currentRuntime) {
    const currentAnnotation = { 'merchant.example.com/config-sha256': configDigest('merchant-runtime', currentRuntime) }
    for (const item of manifest.items) {
      const referencesRuntime = item.spec?.template?.spec?.containers?.some((container: any) => container.envFrom?.some((source: any) => source.configMapRef?.name === 'merchant-runtime'))
      if (referencesRuntime) item.spec.template.metadata.annotations = currentAnnotation
    }
  }
  return JSON.stringify(manifest)
}

describe('structured Kubernetes release image gate', () => {
  it('renders every production scale overlay with effective immutable image replacements and passes the release validator', () => {
    const overlayImageDigests = { ...imageDigests, clamav: 'sha256:761f6c99b8d9134b39431f8c200189cda749b17310091561bfa8b732f32bfada' }
    const replacements: Record<string, string> = {
      'REPLACE_ME/merchant-api@SET_API_IMAGE_DIGEST': `registry.example.com/merchant-api@${imageDigests['merchant-api']}`,
      'REPLACE_ME/merchant-worker@SET_WORKER_IMAGE_DIGEST': `registry.example.com/merchant-worker@${imageDigests['merchant-worker']}`,
      'REPLACE_ME/merchant-ui@SET_UI_IMAGE_DIGEST': `registry.example.com/merchant-ui@${imageDigests['merchant-ui']}`,
      'REPLACE_ME/merchant-ops-ui@SET_OPS_UI_IMAGE_DIGEST': `registry.example.com/merchant-ops-ui@${imageDigests['merchant-ops-ui']}`,
    }
    for (const overlay of ['pilot-50', 'wave-100', 'wave-250', 'target-500']) {
      const raw = execFileSync('kustomize', ['build', `infra/kubernetes/overlays/${overlay}`], { encoding: 'utf8', stdio: 'pipe' })
      expect(raw).not.toContain('ghcr.io/example/merchant-')
      for (const placeholder of Object.keys(replacements)) expect(raw).toContain(placeholder)
      const rendered = Object.entries(replacements).reduce((document, [placeholder, replacement]) => document.replaceAll(placeholder, replacement), raw)
      expect(rendered).not.toMatch(/REPLACE_ME|SET_[A-Z_]+_DIGEST/u)
      const observedImages = [...rendered.matchAll(/^\s*image:\s*(\S+)$/gmu)].map(match => match[1]!)
      expect(observedImages.every(image => image.includes('@sha256:'))).toBe(true)
      expect(runManifest(rendered, JSON.stringify(overlayImageDigests))()).toContain('Kubernetes release manifest gate passed')
    }
  })

  it('binds every base API and worker pod template to the canonical merchant-runtime digest', () => {
    const ruby = [
      'require "psych"',
      'require "digest"',
      'config = Psych.safe_load(File.read(ARGV.fetch(0)), aliases: false)',
      'name = config.dig("metadata", "name")',
      'data = config["data"] || {}',
      'canonical = name + "\\n" + data.sort.map { |key, value| "data.#{key}=#{value}\\n" }.join',
      'print "sha256:#{Digest::SHA256.hexdigest(canonical)}"',
    ].join('; ')
    const expected = execFileSync('ruby', ['-e', ruby, 'infra/kubernetes/base/configmap.yaml'], { encoding: 'utf8' })
    const manifests = `${readFileSync('infra/kubernetes/base/api.yaml', 'utf8')}\n${readFileSync('infra/kubernetes/base/workers.yaml', 'utf8')}`
    const observed = [...manifests.matchAll(/merchant\.example\.com\/config-sha256:\s*"?(sha256:[a-f0-9]{64})"?/gu)].map(match => match[1])
    expect(observed).toHaveLength(7)
    expect(new Set(observed)).toEqual(new Set([expected]))
  })

  it('requires a complete role-scoped worker credential deployment set and rejects shared Secret keys', () => {
    expect(runManifest(productionWorkerCredentialManifest())()).toContain('images=6')
    expect(runManifest(productionWorkerCredentialManifest(true))).toThrow(/not allowed|must bind|must not share/)
  })

  it('keeps the scanner deployment fail-closed until its independent secrets and ClamAV digest are supplied', () => {
    const workers = readFileSync('infra/kubernetes/base/workers.yaml', 'utf8')
    const api = readFileSync('infra/kubernetes/base/api.yaml', 'utf8')
    const config = readFileSync('infra/kubernetes/base/configmap.yaml', 'utf8')
    const ingress = readFileSync('infra/kubernetes/base/ingress.yaml', 'utf8')
    const networkPolicies = readFileSync('infra/kubernetes/base/network-policies.yaml', 'utf8')
    const secretContract = readFileSync('infra/kubernetes/secret-contract.example.yaml', 'utf8')

    expect(workers).toContain('name: merchant-worker-scan')
    expect(workers).toMatch(/name: merchant-worker-scan[\s\S]*?replicas: 2/)
    expect(workers).toContain('rollingUpdate: {maxUnavailable: 0, maxSurge: 1}')
    expect(workers).toContain('requiredDuringSchedulingIgnoredDuringExecution')
    expect(workers).toContain('{name: WORKER_ROLE, value: scan}')
    expect(workers).toContain('ASSET_SCANNER_INTERNAL_API_BASE_URL')
    expect(workers).toContain('name: merchant-scanner-secrets')
    expect(workers).toContain('ASSET_SCANNER_API_TOKEN')
    expect(workers).toContain('ASSET_SCANNER_WORKSPACE_SIGNING_SECRET')
    expect(workers).toContain('ASSET_SCAN_RECEIPT_PRIVATE_KEY_PEM')
    expect(workers).not.toContain('{name: ASSET_SCAN_RECEIPT_PRIVATE_KEY_PEM, valueFrom:')
    expect(workers).toContain('mountPath: /var/run/secrets/merchant-scanner')
    expect(workers).toContain('readOnly: true')
    expect(workers).toContain('path: receipt-private-key.pem')
    expect(workers).toContain('clamav/clamav@sha256:761f6c99b8d9134b39431f8c200189cda749b17310091561bfa8b732f32bfada')
    expect(workers).toContain('nodeSelector: {kubernetes.io/arch: amd64}')
    expect(workers).toContain('clamdscan --ping 1')
    expect(workers).toContain('-mmin -1440')
    expect(workers).toContain('memory: 3Gi')
    expect(workers).toContain('memory: 4Gi')
    expect(config).toMatch(/ALLOW_LOCAL_ASSET_SCAN_FIXTURE:\s*"false"/)
    expect(config).toContain('MCP_AUTHZ_MODE: enforce')
    expect(config).toContain('AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED: "true"')
    expect(config).toContain('ASSET_SCANNER_MODE: clamav_worker')
    expect(config).toContain('ASSET_SCANNER_SERVICE_ID: merchant-asset-scanner-production')
    expect(config).toContain('ASSET_SCAN_APPROVED_SCANNER_SERVICE_IDS: merchant-asset-scanner-production')
    expect(config).toContain('ASSET_SCAN_MIN_DEFINITIONS_VERSION: "28000"')
    expect(workers).toContain('key: ASSET_SCANNER_SERVICE_ID')
    expect(workers).toContain('{name: SCANNER_MINIMUM_READY_INSTANCES, value: "2"}')
    expect(workers).toMatch(/name: merchant-worker-scan[\s\S]*?minAvailable: 2/)
    expect(config).toContain('ASSET_SCANNER_INTERNAL_API_BASE_URL: http://merchant-api-scanner-internal:8787')
    expect(api).toContain('name: merchant-api-scanner-internal')
    expect(api).toMatch(/name: merchant-api-scanner-internal[\s\S]*?publishNotReadyAddresses: true/)
    expect(api).not.toMatch(/name: merchant-api\n[\s\S]*?publishNotReadyAddresses: true[\s\S]*?name: merchant-api-scanner-internal/)
    expect(api).toContain('merchant.example.com/exposure: internal-only')
    expect(ingress).toContain('^/v1/internal(?:/|$)')
    expect(ingress).toContain('return 404')
    expect(ingress.match(/path: \/v1\/internal/g)).toHaveLength(2)
    expect(ingress.match(/name: merchant-internal-deny/g)?.length).toBeGreaterThanOrEqual(3)
    expect(ingress).toContain('merchant.example.com/deny-endpoint: "never"')
    expect(networkPolicies).toContain('name: merchant-api-ingress-boundary')
    expect(networkPolicies).toContain('name: merchant-worker-scan-isolation')
    expect(networkPolicies).toContain('ingress: []')
    expect(networkPolicies).toContain('app.kubernetes.io/name: merchant-worker-scan')
    expect(networkPolicies).toContain('app.kubernetes.io/name: merchant-api')
    expect(secretContract).toContain('name: merchant-scanner-secrets')
    expect(secretContract).toContain('receiptSigningAlgorithm: Ed25519')
    expect(api).toMatch(/name: ASSET_DISPLAY_URL_PREVIOUS_KEYS_JSON[\s\S]*?key: ASSET_DISPLAY_URL_PREVIOUS_KEYS_JSON/)
    expect(api).not.toMatch(/key: ASSET_DISPLAY_URL_PREVIOUS_KEYS_JSON, optional: true/)
    expect(secretContract).toContain('receiptPrivateKeyDelivery: read-only-projected-file')
    expect(secretContract).toContain('neverMountReceiptPrivateKeyIntoApi')
    expect(api).toContain('key: WORKER_API_CREDENTIALS')
    expect(api).not.toContain('key: WORKER_API_TOKEN')
    expect(api).not.toContain('key: WORKER_API_SIGNING_SECRET')
    for (const role of ['SYNC', 'GENERATION', 'PUBLISH', 'RECONCILE', 'AUTOMATION']) {
      expect(workers).toContain(`key: WORKER_${role}_API_TOKEN`)
      expect(workers).toContain(`key: WORKER_${role}_API_SIGNING_SECRET`)
      expect(secretContract).toContain(`- WORKER_${role}_API_TOKEN`)
      expect(secretContract).toContain(`- WORKER_${role}_API_SIGNING_SECRET`)
    }
    expect(secretContract).toContain('- WORKER_API_CREDENTIALS')
    expect(secretContract).toContain('- neverShareWorkerRoleCredentials')

    const baseScannerManifest = [config, api, workers].join('\n---\n')
    expect(runScannerContract(baseScannerManifest)()).toContain('scanner Kubernetes contract passed')

    const unresolved = deployment('containers: [{name: clamav, image: registry.example.com/clamav@sha256:REPLACE_ME}]', 'merchant-worker-scan')
    expect(runManifest(unresolved)).toThrow(/unresolved|immutable/)
  })

  it('accepts quoted image keys and every supported PodSpec container class when all digests match', () => {
    const manifest = deployment([
      'containers:',
      `  - {name: api, "image": registry.example.com/merchant-api@${digest}}`,
      'initContainers:',
      `  - {name: migrate, "image": registry.example.com/merchant-api@${digest}}`,
      'ephemeralContainers:',
      `  - {name: diagnostic, "image": registry.example.com/merchant-api@${digest}}`,
    ].join('\n'))
    expect(runManifest(manifest)()).toContain('images=3')
  })

  it('accepts the complete production image set and returns a stable canonical set digest', () => {
    const manifest = productionScannerManifest()
    const result = runManifest(manifest, JSON.stringify(imageDigests))()
    expect(result).toMatch(/images=5 image_set_digest=sha256:[a-f0-9]{64}/)
    const first = runManifest(manifest, JSON.stringify(imageDigests), ['--print-image-set-digest'])().trim()
    const reordered = Object.fromEntries(Object.entries(imageDigests).reverse())
    const second = runManifest(manifest, JSON.stringify(reordered), ['--print-image-set-digest'])().trim()
    expect(first).toBe(second)
  })

  it('rejects weakened or overridden production authorization configuration even with a recomputed config digest', () => {
    for (const [key, value] of [
      ['MCP_AUTHZ_MODE', 'shadow'],
      ['AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED', 'false'],
    ] as const) {
      const weakened = productionScannerManifest(manifest => { manifest.items[0].data[key] = value })
      expect(runManifest(weakened, JSON.stringify(imageDigests))).toThrow(new RegExp(`${key}=`, 'u'))
    }

    for (const key of ['MCP_AUTHZ_MODE', 'AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED'] as const) {
      const missing = productionScannerManifest(manifest => { delete manifest.items[0].data[key] })
      expect(runManifest(missing, JSON.stringify(imageDigests))).toThrow(new RegExp(`${key}=`, 'u'))
    }

    const literalOverride = productionScannerManifest(manifest => {
      manifest.items[1].spec.template.spec.containers[0].env.push({ name: 'MCP_AUTHZ_MODE', value: 'enforce' })
    })
    expect(runManifest(literalOverride, JSON.stringify(imageDigests))).toThrow(/must not override MCP_AUTHZ_MODE/)

    const referenceOverride = productionScannerManifest(manifest => {
      manifest.items[1].spec.template.spec.containers[0].env.push({ name: 'AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED', valueFrom: { configMapKeyRef: { name: 'merchant-runtime', key: 'AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED' } } })
    })
    expect(runManifest(referenceOverride, JSON.stringify(imageDigests))).toThrow(/must not override AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED/)

    const duplicateConfig = productionScannerManifest(manifest => {
      manifest.items.push({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'authz-override' }, data: { MCP_AUTHZ_MODE: 'enforce' } })
    })
    expect(runManifest(duplicateConfig, JSON.stringify(imageDigests))).toThrow(/ConfigMap\/authz-override must not define/)
  })

  it('rejects production manifests that weaken scanner policy, omit isolated secrets, or bypass ClamAV freshness', () => {
    const unsafeFixture = productionScannerManifest(value => { value.items[0].data.ALLOW_LOCAL_ASSET_SCAN_FIXTURE = 'true' })
    expect(runManifest(unsafeFixture, JSON.stringify(imageDigests))).toThrow(/ALLOW_LOCAL_ASSET_SCAN_FIXTURE/)
    const missingSecret = productionScannerManifest(value => { value.items[1].spec.template.spec.containers[0].env = value.items[1].spec.template.spec.containers[0].env.filter((entry: any) => entry.name !== 'ASSET_SCAN_TRUSTED_PUBLIC_KEYS') })
    expect(runManifest(missingSecret, JSON.stringify(imageDigests))).toThrow(/ASSET_SCAN_TRUSTED_PUBLIC_KEYS/)
    const staleSignaturesAllowed = productionScannerManifest(value => { value.items[0].data.CLAMAV_SIGNATURE_MAX_AGE_MINUTES = '10080' })
    expect(runManifest(staleSignaturesAllowed, JSON.stringify(imageDigests))).toThrow(/SIGNATURE_MAX_AGE/)
    const noFreshnessProbe = productionScannerManifest(value => { value.items[2].spec.template.spec.containers[1].readinessProbe.exec.command = ['sh', '-c', 'clamdscan --ping 1'] })
    expect(runManifest(noFreshnessProbe, JSON.stringify(imageDigests))).toThrow(/readinessProbe/)
  })

  it.each(['MODEL_RELAY_API_KEY', 'PLATFORM_RULE_SYNC_SIGNING_SECRET', 'PAYMENT_PROVIDER_API_KEY', 'PAYMENT_CALLBACK_SECRET'])('requires the API critical Secret binding %s', secretName => {
    const missing = productionScannerManifest(value => {
      value.items[1].spec.template.spec.containers[0].env = value.items[1].spec.template.spec.containers[0].env.filter((entry: any) => entry.name !== secretName)
    })
    expect(runManifest(missing, JSON.stringify(imageDigests))).toThrow(new RegExp(secretName, 'u'))
  })

  it('fails closed when scanner identity, definitions floor, replica quorum, or bootstrap Service routing drift', () => {
    const missingApproved = productionScannerManifest(value => { delete value.items[0].data.ASSET_SCAN_APPROVED_SCANNER_SERVICE_IDS })
    expect(runManifest(missingApproved, JSON.stringify(imageDigests))).toThrow(/ASSET_SCAN_APPROVED_SCANNER_SERVICE_IDS/)
    const mismatchedIdentity = productionScannerManifest(value => { value.items[0].data.ASSET_SCAN_APPROVED_SCANNER_SERVICE_IDS = 'different-scanner' })
    expect(runManifest(mismatchedIdentity, JSON.stringify(imageDigests))).toThrow(/ASSET_SCANNER_SERVICE_ID must be present/)
    const missingFloor = productionScannerManifest(value => { delete value.items[0].data.ASSET_SCAN_MIN_DEFINITIONS_VERSION })
    expect(runManifest(missingFloor, JSON.stringify(imageDigests))).toThrow(/ASSET_SCAN_MIN_DEFINITIONS_VERSION/)
    const singleReplica = productionScannerManifest(value => { value.items[2].spec.replicas = 1 })
    expect(runManifest(singleReplica, JSON.stringify(imageDigests))).toThrow(/replicas must be at least 2/)
    const weakReadyQuorum = productionScannerManifest(value => { value.items[2].spec.template.spec.containers[0].env.find((entry: any) => entry.name === 'SCANNER_MINIMUM_READY_INSTANCES').value = '1' })
    expect(runManifest(weakReadyQuorum, JSON.stringify(imageDigests))).toThrow(/SCANNER_MINIMUM_READY_INSTANCES/)
    const missingServiceBinding = productionScannerManifest(value => { value.items[2].spec.template.spec.containers[0].env = value.items[2].spec.template.spec.containers[0].env.filter((entry: any) => entry.name !== 'ASSET_SCANNER_SERVICE_ID') })
    expect(runManifest(missingServiceBinding, JSON.stringify(imageDigests))).toThrow(/must bind ASSET_SCANNER_SERVICE_ID/)
    const bootstrapLoop = productionScannerManifest(value => { value.items[4].spec.publishNotReadyAddresses = false })
    expect(runManifest(bootstrapLoop, JSON.stringify(imageDigests))).toThrow(/must publish not-ready API addresses/)
    const publicNotReady = productionScannerManifest(value => { value.items[3].spec.publishNotReadyAddresses = true })
    expect(runManifest(publicNotReady, JSON.stringify(imageDigests))).toThrow(/merchant-api must not publish/)
  })

  it('rejects a production image set when any required image is missing or mismatched', () => {
    const manifest = productionScannerManifest(value => { value.items = value.items.filter((item: any) => item.metadata?.name !== 'merchant-ui') })
    expect(runManifest(manifest, JSON.stringify(imageDigests))).toThrow(/does not use required images/)
    const wrong = productionScannerManifest().replace(imageDigests['merchant-api'], `sha256:${'f'.repeat(64)}`)
    expect(runManifest(wrong, JSON.stringify(imageDigests))).toThrow(/canonical image set/)
  })

  it('rejects a quoted mutable workload image even when a ConfigMap contains a valid digest decoy', () => {
    const manifest = [
      'apiVersion: v1',
      'kind: ConfigMap',
      'metadata: {name: digest-decoy}',
      'data:',
      `  image: registry.example.com/decoy@${digest}`,
      '---',
      deployment('containers: [{name: api, "image": registry.example.com/merchant-api:latest}]'),
    ].join('\n')
    expect(runManifest(manifest)).toThrow(/mutable|immutable/)
  })

  it('rejects a mutable initContainer even when the application container is immutable', () => {
    const manifest = deployment([
      `containers: [{name: api, image: registry.example.com/merchant-api@${digest}}]`,
      'initContainers: [{name: migrate, "image": registry.example.com/migrations:latest}]',
    ].join('\n'))
    expect(runManifest(manifest)).toThrow(/initContainers.*migrate|mutable|immutable/)
  })

  it('rejects a manifest where a ConfigMap is the only source of an image field', () => {
    const manifest = ['apiVersion: v1', 'kind: ConfigMap', 'metadata: {name: digest-decoy}', 'data:', `  image: registry.example.com/decoy@${digest}`].join('\n')
    expect(runManifest(manifest)).toThrow(/no supported workload container image/)
  })

  it('rejects a workload container with a different immutable digest', () => {
    const wrongDigest = `sha256:${'b'.repeat(64)}`
    expect(runManifest(deployment(`containers: [{name: api, image: registry.example.com/merchant-api@${wrongDigest}}]`))).toThrow(/canonical image set/)
  })

  it('fails closed for unsupported Kubernetes resource kinds', () => {
    const manifest = ['apiVersion: example.com/v1', 'kind: Rollout', 'metadata: {name: merchant-api}', 'spec: {}'].join('\n')
    expect(runManifest(manifest)).toThrow(/unsupported Kubernetes resource kind: Rollout/)
  })

  it('fails closed for malformed YAML and aliases', () => {
    expect(runManifest('apiVersion: apps/v1\nkind: Deployment\nspec: [')).toThrow(/invalid Kubernetes YAML/)
    expect(runManifest('apiVersion: v1\nkind: ConfigMap\nmetadata: &meta {name: alias}\ndata: *meta')).toThrow(/anchors and aliases are not allowed/)
  })

  it('rejects secrets and cluster-scoped authority from runtime rollback manifests', () => {
    const workloads = Object.entries(imageDigests).map(([name, imageDigest]) => deployment(`containers: [{name: app, image: registry.example.com/${name}@${imageDigest}}]`, name)).join('\n---\n')
    const secret = `apiVersion: v1\nkind: Secret\nmetadata: {name: replacement-credentials}\nstringData: {token: attacker-controlled}`
    expect(runManifest(`${workloads}\n---\n${secret}`, JSON.stringify(imageDigests), ['--rollback'])).toThrow(/forbidden.*Secret/)
    const clusterRole = `apiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata: {name: replacement-admin}\nrules: []`
    expect(runManifest(`${workloads}\n---\n${clusterRole}`, JSON.stringify(imageDigests), ['--rollback'])).toThrow(/forbidden.*ClusterRole/)
  })

  it('rejects Secret resources and whole-Secret injection from normal release manifests without echoing values', () => {
    const secret = 'apiVersion: v1\nkind: Secret\nmetadata: {name: embedded}\nstringData: {token: do-not-print-this-value}'
    const withSecret = runManifest(`${deployment(`containers: [{name: api, image: registry.example.com/merchant-api@${digest}}]`)}\n---\n${secret}`)
    expect(withSecret).toThrow(/Secret resources are forbidden/)
    try {
      withSecret()
    } catch (error) {
      expect(String(error)).not.toContain('do-not-print-this-value')
    }

    const envFrom = deployment(`containers: [{name: api, image: registry.example.com/merchant-api@${digest}, envFrom: [{secretRef: {name: merchant-runtime-secrets}}]}]`)
    expect(runManifest(envFrom)).toThrow(/whole-Secret envFrom injection is forbidden/)
  })

  it('allows only workload-scoped Secret keys and rejects optional or whole-Secret volume access', () => {
    const allowed = deployment(`containers: [{name: api, image: registry.example.com/merchant-api@${digest}, env: [{name: DATABASE_URL, valueFrom: {secretKeyRef: {name: merchant-runtime-secrets, key: DATABASE_URL}}}]}]`)
    expect(runManifest(allowed)()).toContain('images=1')

    const crossWorkload = deployment(`containers: [{name: worker, image: registry.example.com/merchant-api@${digest}, env: [{name: API_AUTH_TOKENS, valueFrom: {secretKeyRef: {name: merchant-runtime-secrets, key: API_AUTH_TOKENS}}}]}]`, 'merchant-worker-automation')
    expect(runManifest(crossWorkload)).toThrow(/not allowed for merchant-worker-automation|requires sync, generation, publish, reconcile, and automation/)
    const optional = allowed.replace('key: DATABASE_URL}', 'key: DATABASE_URL, optional: true}')
    expect(runManifest(optional)).toThrow(/optional Secret key references are forbidden/)
    const volume = deployment(`containers: [{name: api, image: registry.example.com/merchant-api@${digest}}]\nvolumes: [{name: credentials, secret: {secretName: merchant-runtime-secrets}}]`)
    expect(runManifest(volume)).toThrow(/whole-Secret volume injection is forbidden/)
    const projected = deployment(`containers: [{name: api, image: registry.example.com/merchant-api@${digest}}]\nvolumes: [{name: credentials, projected: {sources: [{secret: {name: merchant-runtime-secrets}}]}}]`)
    expect(runManifest(projected)).toThrow(/whole-Secret volume injection is forbidden/)

    const scannerKeyFile = deployment(`containers: [{name: worker, image: registry.example.com/merchant-worker@${digest}}]\nvolumes: [{name: signing-key, projected: {sources: [{secret: {name: merchant-scanner-secrets, items: [{key: ASSET_SCAN_RECEIPT_PRIVATE_KEY_PEM, path: receipt-private-key.pem}]}}]}}]`, 'merchant-worker-scan')
    expect(runManifest(scannerKeyFile)()).toContain('images=1')
  })

  it('binds ConfigMap references to the signed manifest and pod template digest', () => {
    const data = { FEATURE_MODE: 'strict' }
    const config = 'apiVersion: v1\nkind: ConfigMap\nmetadata: {name: merchant-runtime}\ndata: {FEATURE_MODE: strict}'
    const podSpec = `containers: [{name: api, image: registry.example.com/merchant-api@${digest}, envFrom: [{configMapRef: {name: merchant-runtime}}]}]`
    expect(runManifest(`${config}\n---\n${deploymentWithConfig(podSpec, 'merchant-runtime', data)}`)()).toContain('images=1')
    expect(runManifest(deploymentWithConfig(podSpec, 'merchant-runtime', data))).toThrow(/not bound into the rendered manifest/)
    expect(runManifest(`${config}\n---\n${deploymentWithConfig(podSpec, 'merchant-runtime', data, 'merchant-api', `sha256:${'0'.repeat(64)}`)}`)).toThrow(/must bind referenced ConfigMaps/)
    expect(runManifest(`${config}\n---\n${deploymentWithConfig(podSpec.replace('{name: merchant-runtime}', '{name: merchant-runtime, optional: true}'), 'merchant-runtime', data)}`)).toThrow(/optional ConfigMap references are forbidden/)
  })

  it('rejects secret-like ConfigMap keys while allowing opaque secret references', () => {
    const workload = deployment(`containers: [{name: api, image: registry.example.com/merchant-api@${digest}}]`)
    const literalSecret = 'apiVersion: v1\nkind: ConfigMap\nmetadata: {name: unsafe}\ndata: {PAYMENT_API_KEY: exposed}'
    expect(runManifest(`${literalSecret}\n---\n${workload}`)).toThrow(/secret-like ConfigMap key.*PAYMENT_API_KEY/)
    const managedReference = 'apiVersion: v1\nkind: ConfigMap\nmetadata: {name: safe}\ndata: {ALERT_CHANNEL_SECRET_REF: vault:\/\/merchant-alert-channel}'
    expect(runManifest(`${managedReference}\n---\n${workload}`)()).toContain('images=1')
  })
})
