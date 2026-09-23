import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { summarizeOldRuntime, verifyDockerSaveArchive } from '../infra/scripts/ecs-bridge-old-runtime-evidence.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const sha = 'ec3d69e37809c0d622c8f38057a072245217004f'
const apiImage = `sha256:${'a'.repeat(64)}`
const workerImage = `sha256:${'b'.repeat(64)}`
const services = ['api-replica', 'worker-automation', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-scan', 'worker-sync']
const network = (name, id, aliases = []) => [name, { NetworkID: id.repeat(64), Aliases: aliases }]
function container(service, index) {
  const networks = Object.fromEntries([
    network('merchant-production_default', 'c', [`merchant-production-${service}-1`]),
    ...(service === 'api-replica' ? [network('storenova-demo-e0', 'd')] : []),
  ])
  return {
    Id: String(index + 1).padStart(64, '0'),
    Name: `/merchant-production-${service}-1`,
    Image: service === 'api-replica' ? apiImage : workerImage,
    State: { Running: true },
    Config: { Labels: {}, Env: [`RELEASE_GIT_SHA=${sha}`, 'SECRET_KEY=never-print-this-secret'] },
    HostConfig: { Binds: ['/protected/secret-file:/run/secret-file:ro'] },
    Mounts: [{ Source: '/protected/secret-file', Destination: '/run/secret-file' }],
    NetworkSettings: { Networks: networks },
  }
}
function gateway() {
  return {
    Id: 'e'.repeat(64), Name: '/local-pilot-gateway-https-20260914202431', Image: `sha256:${'f'.repeat(64)}`, State: { Running: true },
    Config: { Env: ['GATEWAY_SECRET=never-print-this-secret'] },
    HostConfig: { PortBindings: { '80/tcp': [{ HostPort: '80' }], '443/tcp': [{ HostPort: '443' }] } },
    Mounts: [], NetworkSettings: { Networks: Object.fromEntries([network('merchant-production_default', 'c')]) },
  }
}
const nginx = 'upstream pilot_api {\n server merchant-production-api-replica-1:8787 resolve;\n}\nlocation /api/ {\n proxy_pass http://pilot_api;\n}'

test('freezes exact seven historical identities without disclosing environment or mount source', () => {
  const result = summarizeOldRuntime(services.map(container), gateway(), sha, nginx)
  assert.equal(result.services.length, 7)
  assert.deepEqual(result.preserved_image_ids, [apiImage, workerImage, gateway().Image])
  assert.equal(result.gateway.nginx_config_sha256, hash(nginx))
  assert.ok(!JSON.stringify(result).includes('never-print-this-secret'))
  assert.ok(!JSON.stringify(result).includes('/protected/secret-file'))
})

test('rejects drifted source, gateway topology, Compose labels and worker identity', () => {
  const old = services.map(container)
  assert.throws(() => summarizeOldRuntime(old, gateway(), '1'.repeat(40), nginx), /Git SHA/)
  old[0].Config.Labels['com.docker.compose.project'] = 'merchant-production'
  assert.throws(() => summarizeOldRuntime(old, gateway(), sha, nginx), /Compose ownership/)
  delete old[0].Config.Labels['com.docker.compose.project']
  old[1].Image = apiImage
  assert.throws(() => summarizeOldRuntime(old, gateway(), sha, nginx), /image set/)
  old[1].Image = workerImage
  assert.throws(() => summarizeOldRuntime(old, gateway(), sha, nginx.replace('8787', '9999')), /gateway upstream/)
  const changedGateway = gateway()
  delete changedGateway.HostConfig.PortBindings['443/tcp']
  assert.throws(() => summarizeOldRuntime(old, changedGateway, sha, nginx), /gateway 80\/443/)
})

test('accepts only a real three-image save archive whose config IDs and layer diffIDs match bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-old-evidence-'))
  try {
    const entries = []
    const ids = []
    for (let index = 0; index < 3; index += 1) {
      const layer = `${index}/layer.tar`
      const layerBytes = Buffer.from(`old-image-layer-${index}`)
      const configBytes = Buffer.from(JSON.stringify({ rootfs: { diff_ids: [`sha256:${hash(layerBytes)}`] } }))
      const config = `${hash(configBytes)}.json`
      execFileSync('mkdir', ['-p', join(dir, String(index))])
      writeFileSync(join(dir, layer), layerBytes)
      writeFileSync(join(dir, config), configBytes)
      ids.push(`sha256:${hash(configBytes)}`)
      entries.push({ Config: config, RepoTags: null, Layers: [layer] })
    }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(entries))
    const archive = join(dir, 'old.tar')
    execFileSync('tar', ['-cf', archive, '-C', dir, 'manifest.json', ...entries.flatMap(entry => [entry.Config, entry.Layers[0]])])
    const result = await verifyDockerSaveArchive(archive, ids)
    assert.equal(result.kind, 'docker-save-three-image')
    assert.deepEqual(result.image_ids, ids)
    await assert.rejects(verifyDockerSaveArchive(archive, [ids[0], apiImage, ids[2]]), /differs from running/)
    writeFileSync(join(dir, entries[0].Layers[0]), 'tampered')
    execFileSync('tar', ['-cf', archive, '-C', dir, 'manifest.json', ...entries.flatMap(entry => [entry.Config, entry.Layers[0]])])
    await assert.rejects(verifyDockerSaveArchive(archive, ids), /layer content differs/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
