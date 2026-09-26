import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildBridgeReview } from '../infra/scripts/prepare-ecs-bridge-254-review.mjs'
import { auditBridgeReview } from '../infra/scripts/audit-ecs-bridge-254-review.mjs'

const migrationCommit = 'd0552b975e69f4ba713ec1c003078f521b69f51a'
const temporary: string[] = []
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
function treeInventory(directory: string, prefix = ''): Map<string, string> {
  const result = new Map<string, string>()
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name), relative = prefix ? `${prefix}/${name}` : name
    if (lstatSync(path).isDirectory()) for (const [key, digest] of treeInventory(path, relative)) result.set(key, digest)
    else result.set(relative, sha(readFileSync(path)))
  }
  return result
}
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })

describe('B-derived 254 compatibility audit', () => {
  it('reports the actual source incompatibilities without claiming runtime readiness', () => {
    const parent = mkdtempSync(join(tmpdir(), 'bridge-254-compatibility-'))
    temporary.push(parent)
    const review = join(parent, 'review')
    buildBridgeReview({ migrationCommit, output: review })
    const result = auditBridgeReview(review)
    expect(result).toMatchObject({ status: 'blocked', deployable: false, runtime_verified: false, migration_commit: migrationCommit })
    expect(result.blockers.map(item => item.code)).toEqual(['BRIDGE_PREFIX_CONTRACT_244', 'OCR_VARIABLE_RATE_UNSUPPORTED'])
    expect(result.requires_pg17_evidence).toContain('B entitlement v2 function call under merchant_app workspace RLS after migration 254')
  })

  it('rejects source tampering before producing findings', () => {
    const parent = mkdtempSync(join(tmpdir(), 'bridge-254-compatibility-'))
    temporary.push(parent)
    const review = join(parent, 'review')
    buildBridgeReview({ migrationCommit, output: review })
    const path = join(review, 'review-source/packages/persistence/src/commercial-catalog-repository.ts')
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n// modified\n`)
    expect(() => auditBridgeReview(review)).toThrow('review tree differs from pinned B source')
  })

  it('rejects a source edit even when an attacker recomputes the tree digest', () => {
    const parent = mkdtempSync(join(tmpdir(), 'bridge-254-compatibility-'))
    temporary.push(parent)
    const review = join(parent, 'review')
    buildBridgeReview({ migrationCommit, output: review })
    const path = join(review, 'review-source/packages/persistence/src/commercial-catalog-repository.ts')
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n// rehashed tamper\n`)
    const manifestPath = join(review, 'review-manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const inventory = treeInventory(join(review, 'review-source'))
    manifest.review_tree_sha256 = `sha256:${sha([...inventory].map(([file, digest]) => `${file}\t${digest}\n`).join(''))}`
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    expect(() => auditBridgeReview(review)).toThrow('review tree differs from pinned B source')
  })
})
