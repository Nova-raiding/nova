#!/usr/bin/env node
// The local ChatGPT plugin is a separate artifact.  Check the exact source
// archive and the final API/worker root filesystems before a B takeover.
import { execFileSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export function forbiddenCloudPath(raw, runtime = false) {
  const path = raw.replace(/^(?:\.\/)+/u, '').replace(/\/$/u, '')
  if (!path || path.startsWith('/') || path.split('/').includes('..')) return 'unsafe archive path'
  if (/(^|\/)apps\/plugin(?:\/|$)/u.test(path) || /(^|\/)\.codex-marketplace(?:\/|$)/u.test(path)) return 'local ChatGPT plugin source'
  if (runtime && /(^|\/)dist\/tests(?:\/|$)/u.test(path)) return 'compiled test tree'
  return null
}

async function listTar(command, args, label, runtime = false, input) {
  const listing = spawn(command, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
  const completion = new Promise((resolve, reject) => {
    listing.once('error', reject)
    listing.once('close', code => resolve(code))
  })
  if (input) input.stdout.pipe(listing.stdin)
  let stderr = ''
  listing.stderr.setEncoding('utf8')
  listing.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096) })
  let failure = null
  const lines = createInterface({ input: listing.stdout, crlfDelay: Infinity })
  for await (const path of lines) {
    const reason = forbiddenCloudPath(path, runtime)
    if (reason && !failure) failure = `${label} contains ${reason}: ${path}`
  }
  const status = await completion
  if (status !== 0) throw new Error(`${label} tar listing failed: ${stderr.trim()}`)
  if (failure) throw new Error(failure)
}

async function checkImage(ref, label, sourceSha256) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[0-9a-f]{64}$/u.test(ref)) throw new Error(`${label} must be an immutable image reference`)
  const docker = process.platform === 'darwin' ? 'docker' : '/usr/bin/docker'
  const labelValue = execFileSync(docker, ['image', 'inspect', ref, '--format', '{{index .Config.Labels "com.storenova.release.source_sha256"}}'], { encoding: 'utf8', maxBuffer: 8192 }).trim()
  if (labelValue !== `sha256:${sourceSha256}`) throw new Error(`${label} was not rebuilt from the verified cloud-only source archive`)
  const id = execFileSync(docker, ['create', '--pull=never', '--entrypoint', '/bin/true', ref], { encoding: 'utf8', maxBuffer: 8192 }).trim()
  if (!/^[0-9a-f]{64}$/u.test(id)) throw new Error(`${label} Docker create returned an invalid container ID`)
  try {
    const exported = spawn(docker, ['export', id], { stdio: ['ignore', 'pipe', 'pipe'] })
    const exportCompletion = new Promise((resolve, reject) => {
      exported.once('error', reject)
      exported.once('close', code => resolve(code))
    })
    let exportError = ''
    exported.stderr.setEncoding('utf8')
    exported.stderr.on('data', chunk => { exportError = (exportError + chunk).slice(-4096) })
    await listTar('tar', ['-tf', '-'], label, true, exported)
    const exportedStatus = await exportCompletion
    if (exportedStatus !== 0) throw new Error(`${label} Docker export failed: ${exportError.trim()}`)
  } finally {
    try { execFileSync(docker, ['rm', id], { stdio: 'ignore' }) }
    catch { throw new Error(`${label} temporary inspection container requires manual review: ${id}`) }
  }
}

export async function verifyCloudOnlyArtifacts(archive, scopedCompose, project) {
  if (!archive?.startsWith('/') || !scopedCompose?.startsWith('/') || !/^bridge[a-z0-9_-]{1,56}$/u.test(project ?? '')) throw new Error('absolute archive/Compose and reviewed bridge project are required')
  await listTar('tar', ['-tf', archive], 'cloud source archive')
  const archiveSha256 = execFileSync('shasum', ['-a', '256', archive], { encoding: 'utf8', maxBuffer: 8192 }).trim().split(/\s+/u)[0]
  if (!/^[0-9a-f]{64}$/u.test(archiveSha256)) throw new Error('cloud source archive digest is invalid')
  const docker = process.platform === 'darwin' ? 'docker' : '/usr/bin/docker'
  const config = JSON.parse(execFileSync(docker, ['compose', '-p', project, '-f', scopedCompose, 'config', '--format', 'json'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }))
  const services = ['api-replica', 'worker-automation', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-scan', 'worker-sync']
  if (JSON.stringify(Object.keys(config.services ?? {}).sort()) !== JSON.stringify([...services].sort())) throw new Error('cloud runtime must contain the exact seven reviewed API/worker services')
  const refs = new Map()
  for (const name of services) refs.set(config.services[name].image, name)
  for (const [ref, name] of refs) await checkImage(ref, `${name} runtime image`, archiveSha256)
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  verifyCloudOnlyArtifacts(...process.argv.slice(2)).then(() => {
    process.stdout.write('cloud source and API/worker runtime contain no local ChatGPT plugin frontend\n')
  }).catch(error => { process.stderr.write(`cloud-only artifact boundary rejected: ${error.message}\n`); process.exitCode = 1 })
}
