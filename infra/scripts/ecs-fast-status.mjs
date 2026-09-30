#!/usr/bin/env node
// Read-only inventory. No credentials, environment values, or Compose contents
// leave the host. This is an update plan input, never release approval.
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function assess(snapshot) {
  const blockers = []
  if (snapshot.free_bytes < 8 * 1024 ** 3) blockers.push('disk_free_below_8GiB')
  if (!snapshot.services.length) blockers.push('live_project_missing')
  for (const service of snapshot.services) {
    if (service.state !== 'running' || service.health !== 'healthy') blockers.push(`service_not_healthy:${service.service}`)
    if (!/^.+@sha256:[a-f0-9]{64}$/u.test(service.image)) blockers.push(`image_not_pinned:${service.service}`)
    if (!/^[a-f0-9]{40}$/u.test(service.git_sha ?? '')) blockers.push(`source_revision_missing:${service.service}`)
  }
  for (const name of ['api', 'api-replica', 'ops-ui', 'pilot-gateway', 'postgres', 'redis']) {
    if (!snapshot.services.some(service => service.service === name)) blockers.push(`service_missing:${name}`)
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

const remote = String.raw`
import json,subprocess,shutil

def docker(*args):
    return subprocess.check_output(['docker','--host','unix:///var/run/docker.sock',*args],universal_newlines=True,timeout=20)
ids=docker('ps','-q','--filter','label=com.docker.compose.project=merchant-demo-85575f9c').split()
services=[]
for cid in ids:
    c=json.loads(docker('inspect',cid))[0]
    labels=c['Config'].get('Labels') or {}
    image=json.loads(docker('image','inspect',c['Image']))[0]
    il=image['Config'].get('Labels') or {}
    services.append(dict(service=labels.get('com.docker.compose.service'),container_id=c['Id'],state=c['State']['Status'],health=c['State'].get('Health',{}).get('Status','absent'),image=c['Config']['Image'],image_id=c['Image'],git_sha=il.get('org.opencontainers.image.revision'),compose_path=labels.get('com.docker.compose.project.config_files')))
print(json.dumps(dict(project='merchant-demo-85575f9c',free_bytes=shutil.disk_usage('/').free,services=services)))
`

async function main() {
  if (process.argv.length !== 2) throw new Error('usage: node infra/scripts/ecs-fast-status.mjs (fixed read-only SSH target: 101)')
  const result = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '101', 'python3 -'], {
    input: remote, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
  })
  if (result.status !== 0) throw new Error('101 inventory failed; check SSH and Docker access; no deployment was attempted')
  const snapshot = JSON.parse(result.stdout)
  const probes = []
  for (const url of ['https://yxsona.com/releasez', 'https://yxsona.com/api/readyz', 'https://ops.yxsona.com/healthz']) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'error' })
      const body = await response.json()
      probes.push({ url, status: response.status, ready: body.data?.ready ?? body.data?.status === 'ok', ...(body.data?.release ? { release: body.data.release } : {}) })
    } catch { probes.push({ url, status: null, ready: false }) }
  }
  const blockers = assess(snapshot)
  for (const probe of probes) if (probe.status !== 200 || !probe.ready) blockers.push(`public_probe_failed:${probe.url}`)
  const warnings = [...inventoryWarnings(snapshot), ...snapshot.services.filter(s => ['postgres', 'redis'].includes(s.service) && !s.image.includes('@sha256:')).map(s => `data_service_uses_tag_preserve_running_image_id:${s.service}`)]
  console.log(JSON.stringify({ observed_at: new Date().toISOString(), ...snapshot, probes, blockers, warnings,
    release_approved: false,
    next_step: 'Freeze a target SHA; compare each component revision, verify migration compatibility and required release evidence before updating.',
  }, null, 2))
  if (blockers.length) process.exitCode = 2
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
