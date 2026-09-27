#!/usr/bin/env node
// Verifies that an ordinary ECS source bundle carries the 254 review controls.
// This never turns the main-source bundle into a B-derived bridge image.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REQUIRED_BRIDGE_254_REVIEW_FILES = Object.freeze([
  'infra/scripts/prepare-ecs-bridge-254-review.mjs',
  'infra/scripts/prepare-ecs-bridge-254-review.d.mts',
  'infra/scripts/audit-ecs-bridge-254-review.mjs',
  'infra/scripts/audit-ecs-bridge-254-review.d.mts',
  'infra/scripts/overlay-ecs-bridge-254-review.mjs',
  'infra/scripts/overlay-ecs-bridge-254-review.d.mts',
  'infra/scripts/inspect-ecs-bridge-254-rendered-compose.mjs',
  'infra/scripts/inspect-ecs-bridge-254-rendered-compose.d.mts',
  'infra/scripts/review-ecs-bridge-254-candidate-preflight.mjs',
  'infra/scripts/verify-ecs-bridge-254-review-package.mjs',
  'infra/protected/ecs-bridge-254-maintenance-core.mjs',
  'infra/protected/ecs-bridge-254-review-state.mjs',
  'infra/protected/ecs-bridge-254-review-state.d.mts',
  'infra/protected/ecs-bridge-254-state-store.mjs',
  'infra/protected/ecs-bridge-254-state-store.d.mts',
  'infra/protected/review-ecs-bridge-254-capsule.mjs',
  'infra/protected/review-ecs-bridge-254-capsule.d.mts',
  'tests/bridge-254-compose-chain-smoke.mjs',
  'tests/bridge-254-image-smoke.mjs',
  'tests/bridge-254-maintenance-isolated-io.mjs',
  'tests/bridge-254-maintenance-resume-smoke.mjs',
  'tests/ecs-bridge-254-compatibility-audit.test.ts',
  'tests/ecs-bridge-254-candidate-preflight-review.test.mjs',
  'tests/ecs-bridge-254-maintenance-core.test.mjs',
  'tests/ecs-bridge-254-overlay-isolated.postgres.test.ts',
  'tests/ecs-bridge-254-overlay.test.ts',
  'tests/ecs-bridge-254-rendered-compose-inspection.test.ts',
  'tests/ecs-bridge-254-review-state.test.ts',
  'tests/ecs-bridge-254-source-review.test.ts',
  'tests/ecs-bridge-254-state-store.test.mjs',
  'tests/review-ecs-bridge-254-capsule.test.ts',
  'tests/ecs-bridge-254-review-package.test.mjs',
])

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
function requireValue(value, message) { if (!value) throw new Error(message) }
function entries(lines, label) {
  const values = lines.trim().split(/\r?\n/u).filter(Boolean)
  requireValue(new Set(values).size === values.length, `${label} contains duplicate rows`)
  return values
}

export function verifyBridge254ReviewPackage(directory) {
  const bundle = resolve(directory)
  const archive = join(bundle, 'candidate-source.tar')
  const archiveDigest = sha256(readFileSync(archive))
  const identityLines = entries(readFileSync(join(bundle, 'candidate-identity.txt'), 'utf8'), 'candidate identity')
  const identity = new Map(identityLines.map(line => {
    const index = line.indexOf('=')
    requireValue(index > 0, 'candidate identity contains an invalid row')
    return [line.slice(0, index), line.slice(index + 1)]
  }))
  requireValue(identity.size === identityLines.length, 'candidate identity contains duplicate keys')
  requireValue(identity.get('source_sha256') === `sha256:${archiveDigest}`, 'candidate source archive digest differs from identity')
  const manifestBytes = readFileSync(join(bundle, 'files.txt'))
  requireValue(identity.get('comparison_manifest_sha256') === `sha256:${sha256(manifestBytes)}`, 'candidate comparison manifest digest differs from identity')
  const planBytes = readFileSync(join(bundle, 'sync-plan.tsv'))
  requireValue(identity.get('sync_plan_sha256') === `sha256:${sha256(planBytes)}`, 'candidate sync plan digest differs from identity')
  const manifest = new Set(entries(manifestBytes.toString('utf8'), 'comparison manifest'))
  const plan = new Map()
  for (const line of entries(planBytes.toString('utf8'), 'sync plan').slice(1)) {
    const columns = line.split('\t')
    requireValue(columns.length === 4 && /^[0-9a-f]{64}$/u.test(columns[1]), 'sync plan contains an invalid row')
    requireValue(!plan.has(columns[3]), 'sync plan contains duplicate paths')
    plan.set(columns[3], columns[1])
  }
  const archivePaths = new Set(entries(execFileSync('tar', ['-tf', archive], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }), 'source archive'))
  for (const path of REQUIRED_BRIDGE_254_REVIEW_FILES) {
    requireValue(manifest.has(path), `254 review comparison manifest omits ${path}`)
    requireValue(archivePaths.has(path), `254 review source archive omits ${path}`)
    const digest = plan.get(path)
    requireValue(digest, `254 review sync plan omits ${path}`)
    const archived = execFileSync('tar', ['-xOf', archive, path], { maxBuffer: 16 * 1024 * 1024 })
    requireValue(sha256(archived) === digest, `254 review source digest differs from sync plan: ${path}`)
  }
  return {
    schema_version: 'ecs-bridge-254-review-package/1',
    status: 'review_only', deployable: false,
    source_sha256: `sha256:${archiveDigest}`,
    review_files_verified: REQUIRED_BRIDGE_254_REVIEW_FILES.length,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requireValue(process.argv.length === 4 && process.argv[2] === '--bundle', 'usage: verify-ecs-bridge-254-review-package.mjs --bundle <candidate directory>')
    process.stdout.write(`${JSON.stringify(verifyBridge254ReviewPackage(process.argv[3]))}\n`)
  } catch (error) {
    process.stderr.write(`bridge 254 review package rejected: ${error.message}\n`)
    process.exitCode = 1
  }
}
