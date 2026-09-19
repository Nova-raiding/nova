import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `.env.example` is the deployment contract: every key it declares is a promise
 * that some code path reads it. A key with no reader is worse than a missing
 * key — an operator sets it through the secret manager, believes behaviour
 * changed, and nothing happens. `AI_PRICE_CNY_PER_1K_INPUT_TOKENS`,
 * `AI_PRICE_CNY_PER_1K_OUTPUT_TOKENS`, `IMAGE_PRICE_CNY_PER_IMAGE` and
 * `MODEL_PROVIDER` were exactly that for the entire life of the repo.
 *
 * This gate fails when a declared key has no reader anywhere in the tree.
 * "Reader" means the literal key appears in a code/deploy file, or the key
 * matches a *registered* dynamically-constructed family below. Registration is
 * an explicit, reviewed act with a written reason — the same shape as
 * `SERVER_ONLY_METHODS` in scripts/audit-ops-surface.mjs — so an intentional
 * unreferenced key can never be tolerated silently, and a stale registration is
 * itself caught (see `staleRegistrations`).
 */
const root = process.cwd()
const declaredKeyPattern = /^([A-Z][A-Z0-9_]*)=/gm
const scannedExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.sh', '.rb', '.yml', '.yaml', '.toml'])
// Built output, generated reports and tool caches are not readers: a key that
// only appears in `dist/` or `artifacts/` is still unread by the source tree.
const skippedDirectories = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'artifacts', 'output', '.codegraph', '.claude', '.gstack', '.tmp-mig-verify', '.tmp-ops-measure', '.prefixcheck', '.probe', '.codex-redis-repair-test'])
// Hidden directories are skipped except the ones that ship real code/config.
const scannedDotDirectories = new Set(['.codex-marketplace', '.github'])

/**
 * Keys assembled at runtime from a prefix plus a field name are invisible to a
 * literal search. Each registration names the construction site so a reviewer
 * can check it, and is validated to still match a declared key.
 */
const dynamicKeyFamilies: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /^(?:JD|TAOBAO|TMALL|PDD|XHS|DOUYIN)_(?:ITEMS|REMOTE_ID|TITLE|DESCRIPTION|PRICE|STOCK|SKU|SKU_ID|SKU_NAME|SKU_PRICE|SKU_STOCK|IMAGES|CATEGORY|ATTRIBUTES|REQUEST_ID|STATE|FOUND|MEDIA_ID|MEDIA_URL)_PATH$/,
    reason: 'packages/connectors/src/config.ts `responseMappingFromEnv(source, prefix)` builds `${prefix}_${FIELD}_PATH` (prefix from `platformPrefixes`, field list in that function), so the social response-mapping keys are read by construction instead of by name.',
  },
  {
    pattern: /^(?:JD|TAOBAO|TMALL|PDD|XHS|DOUYIN)_(?:SYNC|CREATE|UPDATE|QUERY)_PATH$/,
    reason: 'packages/connectors/src/config.ts reads `${prefix}_{SYNC,CREATE,UPDATE,QUERY}_PATH` for every entry of `platformPrefixes` (the production branch even fails closed on a missing one), so these never appear as literals.',
  },
  {
    pattern: /^(?:JD|TAOBAO|TMALL|PDD|XHS|DOUYIN)_(?:AUTH|READ|WRITE)_ENABLED$/,
    reason: 'packages/connectors/src/config.ts builds `${prefix}_{AUTH,READ,WRITE}_ENABLED` for every entry of `platformPrefixes` (prefix = that table) in two places: `managedSwitchPrefixFor` reads `${managedSwitchPrefix}_AUTH_ENABLED` and `${switchPrefix}_{READ,WRITE}_ENABLED` for JD/TMALL-shared-TAOBAO/DOUYIN, and `unwiredPlatformSwitches` rejects the same keys for JD/TAOBAO/DOUYIN and for the prefixes no switch reads (TMALL, PDD, XHS) when they are explicitly `true`. So all six prefixes are read by construction; none of them can appear as a literal.',
  },
]

/**
 * Keys that are declared but read by nothing. They are kept rather than deleted
 * because infra/local/docker-compose.ecs-pilot.yml still forwards them and
 * tests/ecs-pilot-api-replica-parity.test.ts asserts that six-prefix switch
 * matrix, so removing them here would only desynchronise `.env.example` from the
 * deployment contract. Every entry must stay *unread*: if someone wires the key
 * up (or deletes it), `keeps the unread-key exemptions honest` goes red and
 * forces this registry to shrink.
 *
 * Empty today. The nine `TMALL_`/`PDD_`/`XHS_` `{AUTH,READ,WRITE}_ENABLED` keys
 * used to be the only entry: they are forwarded to the process but no code read
 * them, so an operator setting `TMALL_WRITE_ENABLED=true` believed tmall writes
 * were enabled while nothing changed. packages/connectors/src/config.ts now
 * *reads* every one of them through `unwiredPlatformSwitches` (derived from
 * `platformPrefixes` and `managedSwitchPrefixFor`) and refuses the whole
 * configuration when such a switch is explicitly `true`, naming the key that
 * does work. The exemption is therefore gone and the switches are registered in
 * `dynamicKeyFamilies` instead, because that reader builds its key names at
 * runtime — exactly like the keys that are wired on purpose. The registry stays
 * in place for the next key that has no reader.
 */
const knownUnreadKeys: ReadonlyArray<{ keys: readonly string[]; reason: string }> = []

function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (skippedDirectories.has(entry.name)) continue
      if (entry.name.startsWith('.') && !scannedDotDirectories.has(entry.name)) continue
      sourceFiles(join(directory, entry.name), found)
      continue
    }
    const dot = entry.name.lastIndexOf('.')
    if (dot > 0 && scannedExtensions.has(entry.name.slice(dot))) found.push(join(directory, entry.name))
  }
  return found
}

// This file is excluded from the corpus: it names the keys it once caught, and
// a gate that counts its own prose as a reader could be silenced by writing the
// key into its own failure message.
const selfFile = join(root, 'tests', 'env-example-read-gate.test.ts')
// Listing a key in a Compose/k8s `environment:` block only forwards it; it does
// not read it. Treating that as a reader would let an inert key pass the gate on
// the strength of its own wiring (which is how TMALL_WRITE_ENABLED hid).
const isDeploymentWiring = (file: string) => /^infra\/.*\.ya?ml$/.test(file.slice(root.length + 1))
const declaredKeys = [...readFileSync(join(root, '.env.example'), 'utf8').matchAll(declaredKeyPattern)].map(match => match[1]!)
const corpus = sourceFiles(root)
  .filter(file => file !== selfFile && !isDeploymentWiring(file))
  .map(file => readFileSync(file, 'utf8'))
  .join('\n')

const exemptKeys = new Set(knownUnreadKeys.flatMap(entry => entry.keys))
const hasLiteralReader = (key: string) => new RegExp(`\\b${key}\\b`).test(corpus)
const hasRegisteredReader = (key: string) => dynamicKeyFamilies.some(family => family.pattern.test(key))
const unread = declaredKeys.filter(key => !hasLiteralReader(key) && !hasRegisteredReader(key) && !exemptKeys.has(key))
const staleRegistrations = dynamicKeyFamilies.filter(family => !declaredKeys.some(key => family.pattern.test(key)))
const staleExemptions = [...exemptKeys].filter(key => !declaredKeys.includes(key) || hasLiteralReader(key) || hasRegisteredReader(key))
const unnamedExemptions = knownUnreadKeys.filter(entry => entry.reason.trim().length < 40 || entry.keys.length === 0)

describe('.env.example read gate', () => {
  it('parsed the declared key set', () => {
    // Without this, a change to the `.env.example` shape would make the gate
    // vacuously green.
    expect(declaredKeys.length).toBeGreaterThan(200)
    expect(declaredKeys).toContain('DATABASE_URL')
  })

  it('has no declared key without a reader', () => {
    expect(unread, `these .env.example keys are declared but never read: delete them, register the dynamic construction site that reads them, or list them in knownUnreadKeys with a reason: ${unread.join(', ')}`).toEqual([])
  })

  it('keeps dynamic-read registrations honest', () => {
    expect(staleRegistrations.map(family => family.pattern.source)).toEqual([])
  })

  it('keeps the unread-key exemptions honest', () => {
    // An exemption for a key that no longer exists, or that now has a reader,
    // is a stale permission slip: it must be removed in the same change.
    expect(staleExemptions, `these knownUnreadKeys entries are stale — the key is gone or now read: ${staleExemptions.join(', ')}`).toEqual([])
    expect(unnamedExemptions.map(entry => entry.keys.join(','))).toEqual([])
  })
})
