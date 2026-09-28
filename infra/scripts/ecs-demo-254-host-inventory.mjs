#!/usr/bin/env node
// Fixed-target, read-only inventory for the demo 254 bridge review.
// This is discovery material only: no host files are written and it never
// authorizes a release or a runtime mutation.
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEMO_254_PROJECT = 'merchant-demo-85575f9c'
export const DEMO_254_EXPECTED_SERVICES = Object.freeze([
  'api', 'api-replica', 'ops-ui', 'pilot-gateway', 'postgres', 'redis', 'ui',
  'payment-gateway', 'worker-automation', 'worker-generation', 'worker-publish',
  'worker-reconcile', 'worker-sync',
])
const SHA = /^[a-f0-9]{64}$/u
const CONTAINER_ID = /^[a-f0-9]{64}$/u
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/u

// The remote program returns a projection and hashes only. In particular, it
// never serializes Config.Env, Config.Cmd, complete labels, mounts, or inspect
// objects. All Docker operations in this program are query-only.
export const REMOTE_INVENTORY_PROGRAM = String.raw`
import hashlib,json,subprocess,sys
DOCKER=['docker','--host','unix:///var/run/docker.sock']
def call(*args):
    return subprocess.check_output(DOCKER+list(args),text=True,timeout=45)
def digest(value):
    raw=json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
    return hashlib.sha256(raw).hexdigest()
ids=call('ps','-a','-q','--no-trunc').split()
if len(ids)>512: raise RuntimeError('container inventory exceeds reviewed bound')
containers=[]
images=set()
for start in range(0,len(ids),32):
    batch=ids[start:start+32]
    found=json.loads(call('inspect',*batch)) if batch else []
    if len(found)!=len(batch): raise RuntimeError('container inspect count mismatch')
    for item in found:
        image_id=item.get('Image','')
        if image_id not in images:
            image=json.loads(call('image','inspect',image_id))
            if len(image)!=1: raise RuntimeError('image inspect count mismatch')
            images.add(image_id)
        config=item.get('Config') or {}
        labels=config.get('Labels') or {}
        state=item.get('State') or {}
        health=(state.get('Health') or {}).get('Status','absent')
        networks=[]
        for name,net in (item.get('NetworkSettings',{}).get('Networks') or {}).items():
            networks.append({'name':name,'id':net.get('NetworkID',''),'aliases':sorted(x for x in (net.get('Aliases') or []) if isinstance(x,str))})
        networks.sort(key=lambda n:n['name'])
        ports=[]
        for target,bindings in (item.get('NetworkSettings',{}).get('Ports') or {}).items():
            for binding in bindings or []:
                ports.append({'container_port':target,'host_ip':binding.get('HostIp',''),'host_port':binding.get('HostPort','')})
        ports.sort(key=lambda p:(p['container_port'],p['host_ip'],p['host_port']))
        mounts=[]
        for mount in item.get('Mounts') or []:
            mounts.append({'type':mount.get('Type',''),'name':mount.get('Name',''),'destination':mount.get('Destination',''),'read_write':mount.get('RW') is True})
        mounts.sort(key=lambda m:(m['destination'],m['type'],m['name']))
        compose={key:labels.get(key,'') for key in ('com.docker.compose.project','com.docker.compose.service','com.docker.compose.project.config_files','com.docker.compose.project.working_dir')}
        env=config.get('Env') or []
        host=item.get('HostConfig') or {}
        containers.append({'id':item.get('Id',''),'state':state.get('Status','unknown'),'health':health,
            'image_id':image_id,
            'compose':compose,'networks':networks,'ports':ports,'mounts':mounts,
            'env_sha256':digest(env),'config_sha256':digest(config),'host_config_sha256':digest(host),
            'mounts_sha256':digest(item.get('Mounts') or [])})
containers.sort(key=lambda c:c['id'])
print(json.dumps({'schema_version':'ecs-demo-254-host-inventory/1','project':${JSON.stringify('merchant-demo-85575f9c')},'containers':containers},sort_keys=True,separators=(',',':')))
`

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function validateRemoteInventory(value) {
  if (!isObject(value) || Object.keys(value).sort().join(',') !== 'containers,project,schema_version'
    || value.schema_version !== 'ecs-demo-254-host-inventory/1' || value.project !== DEMO_254_PROJECT
    || !Array.isArray(value.containers) || value.containers.length > 512) {
    throw new Error('101 inventory schema rejected')
  }
  const ids = new Set()
  for (const item of value.containers) {
    if (!isObject(item) || Object.keys(item).sort().join(',') !== 'compose,config_sha256,env_sha256,health,host_config_sha256,id,image_id,mounts,mounts_sha256,networks,ports,state'
      || !CONTAINER_ID.test(item.id ?? '') || ids.has(item.id) || !IMAGE_ID.test(item.image_id ?? '')
      || typeof item.state !== 'string'
      || !['healthy','unhealthy','starting','absent'].includes(item.health)
      || ![item.env_sha256,item.config_sha256,item.host_config_sha256,item.mounts_sha256].every(v => SHA.test(v ?? ''))
      || !isObject(item.compose) || Object.keys(item.compose).sort().join(',') !== 'com.docker.compose.project,com.docker.compose.project.config_files,com.docker.compose.project.working_dir,com.docker.compose.service'
      || Object.values(item.compose).some(v => typeof v !== 'string')
      || !Array.isArray(item.networks) || !Array.isArray(item.ports) || !Array.isArray(item.mounts)) {
      throw new Error('101 inventory container projection rejected')
    }
    ids.add(item.id)
    for (const net of item.networks) {
      if (!isObject(net) || Object.keys(net).sort().join(',') !== 'aliases,id,name'
        || typeof net.name !== 'string' || !CONTAINER_ID.test(net.id ?? '') || !Array.isArray(net.aliases)
        || net.aliases.some(alias => typeof alias !== 'string')) throw new Error('101 inventory network rejected')
    }
    for (const port of item.ports) {
      if (!isObject(port) || Object.keys(port).sort().join(',') !== 'container_port,host_ip,host_port'
        || Object.values(port).some(v => typeof v !== 'string')) throw new Error('101 inventory port rejected')
    }
    for (const mount of item.mounts) {
      if (!isObject(mount) || Object.keys(mount).sort().join(',') !== 'destination,name,read_write,type'
        || ['destination','name','type'].some(key => typeof mount[key] !== 'string')
        || typeof mount.read_write !== 'boolean') throw new Error('101 inventory mount rejected')
    }
  }
  return value
}

export function classifyInventory(snapshot) {
  validateRemoteInventory(snapshot)
  const expected = new Map(DEMO_254_EXPECTED_SERVICES.map(service => [service, []]))
  const containers = snapshot.containers.map(item => {
    const service = item.compose['com.docker.compose.service']
    const isExpected = item.compose['com.docker.compose.project'] === DEMO_254_PROJECT && expected.has(service)
    if (isExpected) expected.get(service).push(item)
    return { ...item, classification: isExpected ? 'expected_demo_role' : 'unclassified_external_consumer' }
  })
  const blockers = []
  for (const [service, matches] of expected) {
    if (matches.length === 0) blockers.push(`expected_service_missing:${service}`)
    if (matches.length > 1) blockers.push(`expected_service_duplicate:${service}`)
    for (const item of matches) {
      if (item.state !== 'running') blockers.push(`expected_service_not_running:${service}`)
      if (item.health === 'unhealthy') blockers.push(`expected_service_unhealthy:${service}`)
    }
  }
  const external = containers.filter(item => item.classification === 'unclassified_external_consumer')
  for (const item of external) blockers.push(`unclassified_external_consumer:${item.id}`)
  return Object.freeze({ schema_version: snapshot.schema_version, project: snapshot.project,
    observed_at: new Date().toISOString(), containers, expected_services: [...expected.keys()],
    unclassified_external_consumer_ids: external.map(item => item.id), blockers,
    inventory_only: true, release_approved: false })
}

export function acquireInventory(run = spawnSync) {
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '101', 'python3 -']
  const result = run('ssh', args, { input: REMOTE_INVENTORY_PROGRAM, encoding: 'utf8',
    timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } })
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    throw new Error('101 read-only inventory failed; no deployment was attempted')
  }
  let parsed
  try { parsed = JSON.parse(result.stdout) } catch { throw new Error('101 inventory JSON rejected') }
  return classifyInventory(parsed)
}

function main() {
  if (process.argv.length !== 2) throw new Error('usage: node infra/scripts/ecs-demo-254-host-inventory.mjs (fixed read-only SSH target: 101)')
  const result = acquireInventory()
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (result.blockers.length) process.exitCode = 2
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
