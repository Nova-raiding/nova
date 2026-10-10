#!/usr/bin/env node
// Read-only inventory. No credentials, environment values, or Compose contents
// leave the host. This is an update plan input, never release approval.
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CANONICAL_DEMO_SERVICES = Object.freeze([
  'api', 'api-replica', 'clamav', 'ops-ui', 'payment-gateway', 'pilot-gateway',
  'postgres', 'redis', 'ui', 'worker-automation', 'worker-generation',
  'worker-publish', 'worker-reconcile', 'worker-scan', 'worker-sync',
])

export function assess(snapshot) {
  const blockers = []
  if (snapshot.free_bytes < 8 * 1024 ** 3) blockers.push('disk_free_below_8GiB')
  if (!snapshot.services.length) blockers.push('live_project_missing')
  const names = snapshot.services.map(service => service.service)
  const actual = new Set(names)
  for (const name of CANONICAL_DEMO_SERVICES) {
    if (!actual.has(name)) blockers.push(`service_missing:${name}`)
  }
  for (const name of actual) {
    if (!CANONICAL_DEMO_SERVICES.includes(name)) blockers.push(`service_unexpected:${name}`)
  }
  for (const name of actual) {
    if (names.filter(item => item === name).length > 1) blockers.push(`service_duplicate:${name}`)
  }
  for (const service of snapshot.services) {
    if (service.state !== 'running' || service.health !== 'healthy') blockers.push(`service_not_healthy:${service.service}`)
    const repositoryDigest = /^.+@sha256:[a-f0-9]{64}$/u.test(service.image ?? '')
    const exactLocalImageId = /^sha256:[a-f0-9]{64}$/u.test(service.image ?? '') && service.image === service.image_id
    if (!repositoryDigest && !exactLocalImageId) blockers.push(`image_not_pinned:${service.service}`)
    if (!/^[a-f0-9]{40}$/u.test(service.git_sha ?? '')) blockers.push(`source_revision_missing:${service.service}`)
  }
  // Upstream database/cache images have no repository Git SHA; do not invent one.
  // Third-party infrastructure images are pinned by immutable digest but do
  // not carry this repository's Git revision label. Never invent one for
  // ClamAV; its digest is the provenance boundary used by the host.
  return blockers.filter(value => ![
    'source_revision_missing:postgres', 'source_revision_missing:redis', 'source_revision_missing:clamav',
    'image_not_pinned:postgres', 'image_not_pinned:redis', 'image_not_pinned:clamav',
  ].includes(value))
}

export function inventoryWarnings(snapshot) {
  const revisions = new Set(snapshot.services
    .filter(service => !['postgres', 'redis', 'clamav'].includes(service.service)
      && /^[a-f0-9]{40}$/u.test(service.git_sha ?? ''))
    .map(service => service.git_sha))
  return revisions.size > 1 ? ['application_services_have_mixed_source_revisions'] : []
}

export function isManagedDemoContainerName(name) {
  return typeof name === 'string' && /^merchant-demo-85575f9c-[a-z0-9][a-z0-9-]*-[0-9]+$/u.test(name)
}

export function inventoryStatus(blockers) {
  const demoRuntimeHealthy = blockers.length === 0
  return {
    scope: 'inventory_only',
    environment_scope: 'canonical_demo',
    demo_runtime_healthy: demoRuntimeHealthy,
    // Kept for consumers that treat this field as a conservative candidate
    // update signal. This read-only inventory never grants approval.
    release_approved: false,
    next_step: demoRuntimeHealthy
      ? 'Canonical Demo inventory healthy. Freeze a target SHA; compare each component revision, verify migration compatibility and required Demo evidence before updating.'
      : 'Canonical Demo inventory has blockers. Resolve the reported blockers before updating.',
  }
}

export const PUBLIC_PROBE_URLS = Object.freeze([
  'https://yxsona.com/releasez',
  'https://yxsona.com/api/healthz',
  'https://yxsona.com/api/readyz',
  'https://ops.yxsona.com/healthz',
])

export async function collectPublicProbes(fetchImpl = fetch) {
  const probes = []
  for (const url of PUBLIC_PROBE_URLS) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000), redirect: 'error' })
      const body = await response.json()
      probes.push({ url, status: response.status, ready: body.data?.ready ?? body.data?.status === 'ok',
        ...(body.data?.release ? { release: body.data.release } : {}),
        ...(body.data?.setup?.mode ? { mode: body.data.setup.mode } : {}) })
    } catch { probes.push({ url, status: null, ready: false }) }
  }
  return probes
}

export function publicProbeBlockers(probes) {
  const blockers = probes.filter(probe => probe.status !== 200 || !probe.ready)
    .map(probe => `public_probe_failed:${probe.url}`)
  for (const probe of probes) {
    if (probe.url === 'https://yxsona.com/api/healthz' && probe.mode !== 'demo') {
      blockers.push(`public_demo_mode_invalid:${probe.url}`)
    }
  }
  return blockers
}

export function publicIdentityBlockers(snapshot, probes) {
  const probe = probes.find(item => item.url === 'https://yxsona.com/releasez')
  const publicSha = probe?.release?.release_git_sha
  const apiShas = snapshot.services.filter(service => ['api', 'api-replica'].includes(service.service))
    .map(service => service.runtime_release_git_sha)
  if (!/^[a-f0-9]{40}$/u.test(publicSha ?? '') || apiShas.length !== 2
    || apiShas.some(value => !/^[a-f0-9]{40}$/u.test(value ?? '') || value !== publicSha)) {
    return ['public_release_identity_mismatch']
  }
  return []
}

const remote = String.raw`
import json,subprocess,shutil

DOCKER_CALL_TIMEOUT_SECONDS=45
def docker(*args):
    return subprocess.check_output(['docker','--host','unix:///var/run/docker.sock',*args],universal_newlines=True,timeout=DOCKER_CALL_TIMEOUT_SECONDS)
ids=docker('ps','-q','--filter','label=com.docker.compose.project=merchant-demo-85575f9c').split()
services=[]
for cid in ids:
    c=json.loads(docker('inspect',cid))[0]
    labels=c['Config'].get('Labels') or {}
    name=c.get('Name','').lstrip('/')
    if not name.startswith('merchant-demo-85575f9c-'):
        continue
    image=json.loads(docker('image','inspect',c['Image']))[0]
    il=image['Config'].get('Labels') or {}
    service=labels.get('com.docker.compose.service')
    item=dict(service=service,container_id=c['Id'],state=c['State']['Status'],health=c['State'].get('Health',{}).get('Status','absent'),image=c['Config']['Image'],image_id=c['Image'],git_sha=il.get('org.opencontainers.image.revision'),compose_path=labels.get('com.docker.compose.project.config_files'))
    if service in ('api','api-replica'):
        item['runtime_release_git_sha']=next((entry.partition('=')[2] for entry in (c['Config'].get('Env') or []) if entry.startswith('RELEASE_GIT_SHA=')),None)
    services.append(item)
print(json.dumps(dict(project='merchant-demo-85575f9c',free_bytes=shutil.disk_usage('/').free,services=services)))
`

async function main() {
  if (process.argv.length !== 2) throw new Error('usage: node infra/scripts/ecs-fast-status.mjs (fixed read-only SSH target: 101)')
  const result = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '101', 'python3 -'], {
    input: remote, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
  })
  if (result.status !== 0) throw new Error('101 inventory failed; check SSH and Docker access; no deployment was attempted')
  const snapshot = JSON.parse(result.stdout)
  const probes = await collectPublicProbes()
  const blockers = assess(snapshot)
  blockers.push(...publicProbeBlockers(probes))
  blockers.push(...publicIdentityBlockers(snapshot, probes))
  const warnings = [...inventoryWarnings(snapshot), ...snapshot.services.filter(s => ['postgres', 'redis'].includes(s.service) && !s.image.includes('@sha256:')).map(s => `data_service_uses_tag_preserve_running_image_id:${s.service}`)]
  console.log(JSON.stringify({ observed_at: new Date().toISOString(), ...snapshot, probes, blockers, warnings,
    ...inventoryStatus(blockers),
  }, null, 2))
  if (blockers.length) process.exitCode = 2
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
