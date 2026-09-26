import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import * as crypto from 'node:crypto'
import { buildBridgeReview } from '../infra/scripts/prepare-ecs-bridge-254-review.mjs'
import { buildBridgeOverlay } from '../infra/scripts/overlay-ecs-bridge-254-review.mjs'

const migrationCommit = 'd0552b975e69f4ba713ec1c003078f521b69f51a'
const temporary: string[] = []
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })

function prepare() {
  const parent = mkdtempSync(join(tmpdir(), 'bridge-254-overlay-'))
  temporary.push(parent)
  const review = join(parent, 'review'), output = join(parent, 'overlay')
  buildBridgeReview({ migrationCommit, output: review })
  const manifest = buildBridgeOverlay({ review, output })
  return { review, output, manifest }
}

describe('B-derived 242/254 review overlay', () => {
  it('changes only the verifier and catalog, and remains non-deployable', () => {
    const { review, output, manifest } = prepare()
    expect(manifest).toMatchObject({ status: 'review_only', deployable: false, runtime_verified: false })
    expect(manifest.changed_paths).toEqual(['packages/persistence/src/commercial-catalog-repository.ts', 'packages/persistence/src/migration.ts'])
    expect(manifest.missing_proof).toContain('isolated PG17 242/254 API and six-worker execution')
    expect(manifest.missing_proof).toContain('separate reviewed Compose/preflight/package verifier: B deploy-preflight and package verifier require prefix_242_or_244')
    expect(() => buildBridgeOverlay({ review, output })).toThrow('new absolute canonical path')
  })

  it('accepts only a verified 242 or 254 prefix under the separate bridge mode', () => {
    const { output } = prepare()
    const source = readFileSync(join(output, 'overlay-source/packages/persistence/src/migration.ts'), 'utf8')
    const body = source.match(/export function verifyBridgeMigrationPrefix\([\s\S]*?\): 242 \| 254 \{([\s\S]*?)\n\}\n/u)?.[1]
    expect(body).toBeDefined()
    let checked = 0
    const verifier = new Function('verifyAppliedMigrations', 'migrationChecksumBaseline', `return (applied, expected, mode) => {${body}\n}`)(
      (applied: unknown[], expected: unknown[]) => { checked += 1; if (applied[0] !== expected[0]) throw new Error('checksum mismatch') },
      () => ({}),
    ) as (applied: unknown[], expected: unknown[], mode: string) => number
    const expected = Array.from({ length: 254 }, (_, index) => ({ version: index + 1 }))
    expect(verifier(expected.slice(0, 242), expected, 'prefix_242_or_254')).toBe(242)
    expect(verifier(expected, expected, 'prefix_242_or_254')).toBe(254)
    expect(checked).toBe(2)
    for (const count of [243, 244, 247, 248, 253]) expect(() => verifier(expected.slice(0, count), expected, 'prefix_242_or_254')).toThrow('exactly 242 or 254')
    expect(() => verifier(expected, expected, 'prefix_242_or_244')).toThrow('not enabled')
    expect(() => verifier(expected, expected.slice(0, 244), 'prefix_242_or_254')).toThrow('complete migration chain through 254')
    expect(() => verifier([{ version: 1, checksum: 'foreign' }, ...expected.slice(1)], expected, 'prefix_242_or_254')).toThrow('checksum mismatch')
  })

  it('blocks OCR quote before DB access and displays variable rates as non-executable', async () => {
    const { output } = prepare()
    const source = readFileSync(join(output, 'overlay-source/packages/persistence/src/commercial-catalog-repository.ts'), 'utf8')
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    const exports: Record<string, any> = {}
    new Function('require', 'exports', code)((id: string) => {
      if (id === 'node:crypto') return crypto
      throw new Error(`unexpected import ${id}`)
    }, exports)
    let connections = 0
    const pool = { connect: async () => { connections += 1; return { query: async () => ({ rows: [{
      id: 'rate-ocr-v4', rateCardId: 'rate-card-ocr-v4', version: 4, actionCode: 'ocr.extract', unit: 'request',
      integerPoints: null, pricingMode: 'variable', lifecycle: 'approved', approvalStatus: 'approved',
      executable: true, ruleExecutable: true, checksum: 'checksum', effectiveAt: new Date(), blockers: [],
    }] }), release() {} } } }
    const catalog = new exports.PostgresCommercialCatalogRepository(pool)
    await expect(catalog.resolveApprovedRate('ocr.extract')).rejects.toMatchObject({ code: 'RATE_CARD_UNAVAILABLE' })
    expect(connections).toBe(0)
    await expect(catalog.listRates()).resolves.toMatchObject([{ pricingMode: 'variable', ruleExecutable: false, blockers: ['BRIDGE_VARIABLE_OCR_RATE_UNSUPPORTED'] }])
  })
})
