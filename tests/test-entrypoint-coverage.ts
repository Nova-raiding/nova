/**
 * Two-sided reconciliation between the test files that exist on disk and the
 * entrypoints that actually collect them.
 *
 * The previous version of this check asked `package.json`'s `check` script
 * whether it contained the string `npm test` and returned `false` for every
 * non-ops-console file, so `uncovered` was always empty: the check could not
 * fail. It also scanned only `apps/`, `packages/`, `tests/` and
 * `demo/merchant-studio`, so anything under `.codex-marketplace/**` or
 * `dogfood/**` never entered the ledger at all — which is exactly where the
 * dead files were (six plugin contract tests, one of them broken since it was
 * written, and a dogfood suite collected by nothing).
 *
 * This module keeps two independent ledgers and compares them:
 *
 *   - **What runs.** `vitest list --filesOnly` against the real default
 *     configuration, plus the explicit file manifests of the dedicated
 *     launchers (`LOCAL_RUNTIME_TEST_FILES`, `ISOLATED_POSTGRES_TEST_FILES`,
 *     `ISOLATED_REDIS_TEST_FILES`) and every test path named in a
 *     `package.json` script. This is an enumeration, not a string match.
 *   - **What exists.** A recursive scan of the whole repository, including the
 *     directories the old scan root excluded.
 *
 * A file on the second list and not the first has no entrypoint. That is a
 * finding, and the only accepted answer is a register entry with a reason —
 * so the gap is a checklist somebody owns rather than an absence nobody sees.
 *
 * `NON_HERMETIC_TEST_FILES` is deliberately NOT an entrypoint here: being
 * excluded from the default suite says nothing about whether anything else
 * runs the file. Treating it as coverage is what hid
 * `apps/api/src/canonical-backfill-contract.test.ts`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { ISOLATED_POSTGRES_TEST_FILES } from '../vitest.postgres.config.js'
import { ISOLATED_REDIS_TEST_FILES } from '../vitest.redis.config.js'
import { LOCAL_RUNTIME_TEST_FILES } from './local-runtime-test-safety.js'

const IGNORED_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', 'artifacts', 'test-results',
  'screenshots', '.next', '.turbo', '.vite', 'tmp', 'playwright-report',
])

/**
 * Extensions a test file is written in. The previous pair covered `.test.ts`,
 * `.test.tsx` and `.spec.js` only, which made `.test.js`, `.test.mjs` and
 * `.spec.ts` invisible to *both* sides of the ledger: the "what exists" scan
 * never saw them, so nothing could report them as uncollected no matter what the
 * collector enumeration said. Two probes dropped into the tree —
 * `orphan-probe2.test.js` and `orphan-probe3.spec.ts` — left this whole file
 * green. That is the same shape of defect as the dead plugin tests the widened
 * scan root was introduced for: a file nothing runs, and nothing that says so.
 *
 * Widening the suffix cannot pull in generated trees: `filesOnDisk` prunes
 * directories by name (`IGNORED_DIRECTORIES` — `node_modules`, `dist`, `build`,
 * `coverage`, …) before it matches anything, and the matcher only ever sees a
 * file's own name.
 */
const TEST_EXTENSIONS = 'ts|tsx|js|jsx|mjs|cjs|mts|cts'
const VITEST_TEST_FILE = new RegExp(`\\.test\\.(?:${TEST_EXTENSIONS})$`, 'u')
const BROWSER_SPEC_FILE = new RegExp(`\\.spec\\.(?:${TEST_EXTENSIONS})$`, 'u')
/** The same shapes where they are named inside a command or a document. */
const TEST_PATH_IN_COMMAND = new RegExp(`([A-Za-z0-9_./-]*\\.test\\.(?:${TEST_EXTENSIONS}))(?=[\\s"']|$)`, 'gu')
const SPEC_PATH_IN_SCRIPT = new RegExp(`['"\`]([A-Za-z0-9_][A-Za-z0-9_./-]*\\.spec\\.(?:${TEST_EXTENSIONS}))['"\`]`, 'gu')
const TEST_LINK_IN_DOCUMENT = new RegExp(`\\]\\(<?([^)\\s>]+\\.(?:test|spec)\\.(?:${TEST_EXTENSIONS}))>?\\)`, 'gu')

/** Every file under `root` whose name matches, ignoring generated directories. */
export function filesOnDisk(root: string, matches: (name: string) => boolean, directory = root): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue
      found.push(...filesOnDisk(root, matches, join(directory, entry.name)))
    } else if (entry.isFile() && matches(entry.name)) {
      found.push(relative(root, join(directory, entry.name)).replaceAll('\\', '/'))
    }
  }
  return found.sort()
}

export function vitestTestFilesOnDisk(root: string): string[] {
  return filesOnDisk(root, name => VITEST_TEST_FILE.test(name))
}

export function browserSpecFilesOnDisk(root: string): string[] {
  return filesOnDisk(root, name => BROWSER_SPEC_FILE.test(name))
}

/**
 * What the default suite actually collects. Asking Vitest rather than
 * re-deriving `include`/`exclude` keeps the ledger honest when the
 * configuration changes: a glob that stops matching shows up here.
 */
export function defaultSuiteTestFiles(root: string): string[] {
  const output = execFileSync(process.execPath, [
    join(root, 'node_modules/vitest/vitest.mjs'), 'list', '--filesOnly', '--config', 'vitest.config.ts',
  ], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return output.split('\n').map(line => line.trim().replaceAll('\\', '/')).filter(Boolean).sort()
}

/** Test paths named literally in a `package.json` script. */
export function packageScriptTestFiles(root: string): Set<string> {
  const scripts = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
  const files = new Set<string>()
  for (const command of Object.values(scripts)) {
    for (const match of command.matchAll(TEST_PATH_IN_COMMAND)) files.add(match[1]!)
  }
  return files
}

/** Test paths owned by a dedicated launcher manifest. */
export function manifestTestFiles(): Set<string> {
  return new Set<string>([
    ...LOCAL_RUNTIME_TEST_FILES,
    ...ISOLATED_POSTGRES_TEST_FILES,
    ...ISOLATED_REDIS_TEST_FILES,
  ])
}

/** Every test file this repository has an executing entrypoint for. */
export function entrypointTestFiles(root: string): Set<string> {
  return new Set<string>([
    ...defaultSuiteTestFiles(root),
    ...packageScriptTestFiles(root),
    ...manifestTestFiles(),
  ])
}

export interface UncollectedTestFile {
  /** Repository-relative path. */
  file: string
  /** Why nothing collects it, and what would have to change. */
  reason: string
}

/**
 * Test files that exist on disk, are collected by nothing, and are known.
 *
 * Every entry is a live gap, not a licence: the reconciliation below fails if
 * an entry stops being uncollected (it was wired up — remove the entry) or if
 * a file appears that is not on this list (a new orphan — wire it or justify
 * it here). An empty list is the goal.
 */
export const UNCOLLECTED_VITEST_TEST_FILES: readonly UncollectedTestFile[] = [
  {
    file: '.codex-marketplace/plugins/merchant-marketing/skills/six-platform-public-import/scripts/extract-product.test.mjs',
    reason: 'Vendored plugin-skill self-test: a hand-rolled `node:assert` script run by hand with `node`, never by a test runner. Nothing collects it — the vitest `include` lists `.test.ts`/`.test.tsx` only, and the plugin package declares no scripts at all — so it was invisible until the scan stopped requiring a `.ts`/`.tsx` suffix. The identical file is duplicated under `apps/plugin/**`, and both are named here rather than left unseen; wire them into a script, or delete them, to remove these two entries.',
  },
  {
    file: 'apps/api/src/canonical-backfill-contract.test.ts',
    reason: 'Quarantined merchant bearer-login contract. It is excluded from the default suite (NON_HERMETIC_TEST_FILES) and no dedicated launcher binds it: its own comment says it is not claimed as passing until a signed, isolated runtime migration exists. Not a placeholder — a gap with an owner, tracked here because "has no entrypoint at all" is a different defect from "runs somewhere else".',
  },
  {
    file: 'apps/plugin/skills/six-platform-public-import/scripts/extract-product.test.mjs',
    reason: 'Second copy of the vendored plugin-skill self-test above, byte-identical to the `.codex-marketplace` one. Same gap, same answer: it asserts on `extract-product.mjs` and is executed by nothing — no package script, no launcher manifest, and a vitest `include` that cannot match `.mjs`. Named here so the ledger reports it instead of silently missing it.',
  },
]

/** Browser specs no Playwright project or runner argument schedules. */
export const UNSCHEDULED_BROWSER_SPECS: readonly UncollectedTestFile[] = [
  {
    file: 'demo/merchant-studio/canonical-product-desktop.spec.js',
    reason: 'Playwright spec with no owning project: demo/merchant-studio has no playwright config and no npm script names this file. doc/todo/quality/test-strategy-2026-09-07.md already asks for an explicit entrypoint for it; until then it is a known unscheduled spec, not silently collected coverage.',
  },
  {
    file: 'demo/merchant-studio/image-generation-desktop-responsive.spec.js',
    reason: 'Playwright spec with no owning project; documents cite its desktop-width coverage as evidence, so it must become scheduled or those citations must stop counting it.',
  },
  {
    file: 'demo/merchant-studio/image-generation-desktop.spec.js',
    reason: 'Playwright spec with no owning project; same gap as canonical-product-desktop.spec.js. The responsive sibling is also unscheduled.',
  },
]

/** `**`/`*`/`?` glob matching, path separators normalized to `/`. */
export function globMatches(pattern: string, file: string): boolean {
  const normalized = pattern.replaceAll('\\', '/')
  let regex = ''
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!
    if (character === '*') {
      if (normalized[index + 1] === '*') {
        index += 1
        // `**/` spans zero or more directories: `**/*.spec.js` must match a
        // spec beside the config as well as one several levels down.
        if (normalized[index + 1] === '/') { index += 1; regex += '(?:.*/)?' } else regex += '.*'
      } else regex += '[^/]*'
    } else if (character === '?') regex += '[^/]'
    else regex += character.replace(/[.+^${}()|[\]\\]/gu, '\\$&')
  }
  return new RegExp(`^${regex}$`, 'u').test(file)
}

function literalList(source: string, key: string): string[] {
  const match = new RegExp(`${key}\\s*:\\s*(\\[[^\\]]*\\]|'[^']*')`, 'u').exec(source)
  if (!match) return []
  return [...match[1]!.matchAll(/'([^']*)'/gu)].map(item => item[1]!)
}

/**
 * Specs a Playwright project collects: every `playwright.config.*` applies its
 * `testMatch`/`testIgnore` to the directory that owns it. A spec matched by no
 * project and named by no runner argument has no collector — the browser
 * equivalent of an uncollected vitest file.
 */
export function playwrightCollectedSpecs(root: string, specs = browserSpecFilesOnDisk(root)): Set<string> {
  const collected = new Set<string>()
  const configs = filesOnDisk(root, name => /^playwright\.config\.[cm]?[jt]s$/u.test(name))
  for (const config of configs) {
    const directory = config.includes('/') ? config.slice(0, config.lastIndexOf('/')) : ''
    const source = readFileSync(resolve(root, config), 'utf8')
    const testMatch = literalList(source, 'testMatch')
    const testIgnore = literalList(source, 'testIgnore')
    if (!testMatch.length) continue
    for (const spec of specs) {
      const local = directory ? (spec.startsWith(`${directory}/`) ? spec.slice(directory.length + 1) : undefined) : spec
      if (local === undefined) continue
      if (testMatch.some(pattern => globMatches(pattern, local)) && !testIgnore.some(pattern => globMatches(pattern, local))) collected.add(spec)
    }
  }
  return collected
}

/**
 * Browser specs named by a runner argument, e.g. `npm run test:browser:ops`.
 * Only `scripts/**` is scanned: a launcher that names a spec is an entrypoint,
 * while a path mentioned inside a test file (including this module's own
 * register) is not — a self-match would silently certify itself.
 */
export function runnerArgumentSpecs(root: string): Set<string> {
  const files = new Set<string>()
  for (const file of filesOnDisk(root, name => /\.(?:ts|mjs|js)$/u.test(name)).filter(name => name.startsWith('scripts/'))) {
    const source = readFileSync(resolve(root, file), 'utf8')
    for (const match of source.matchAll(SPEC_PATH_IN_SCRIPT)) {
      if (match[1]!.includes('/')) files.add(match[1]!)
    }
  }
  return files
}

export function findUncollectedVitestTests(root: string): string[] {
  const collected = entrypointTestFiles(root)
  return vitestTestFilesOnDisk(root).filter(file => !collected.has(file))
}

export function findUnscheduledBrowserSpecs(root: string): string[] {
  const scheduled = new Set<string>([...playwrightCollectedSpecs(root), ...runnerArgumentSpecs(root)])
  return browserSpecFilesOnDisk(root).filter(file => !scheduled.has(file))
}

/**
 * Markdown links that claim a test file which is not in the repository.
 *
 * This is the check that would have caught
 * `dogfood/chatgpt-all-functions/report.md`, which cited
 * `./ops-members-lifecycle.spec.js`, reported `1 passed (33.1s)` for it and
 * tabulated the write protocols it captured. The file never existed — `find`
 * and `git log --all` both come back empty — so a claim of passing browser
 * evidence rested on nothing. Documents may describe a gap; they may not cite
 * a file that was never written.
 */
export function brokenDocumentTestReferences(root: string): string[] {
  const broken: string[] = []
  for (const file of filesOnDisk(root, name => name.endsWith('.md'))) {
    const directory = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : ''
    for (const match of readFileSync(resolve(root, file), 'utf8').matchAll(TEST_LINK_IN_DOCUMENT)) {
      const target = match[1]!
      if (/^[a-z][a-z0-9+.-]*:/iu.test(target)) continue
      const resolved = target.startsWith('/') ? target.slice(1) : join(directory, target)
      if (!existsSync(resolve(root, resolved))) broken.push(`${file} -> ${target}`)
    }
  }
  return broken.sort()
}

/**
 * Entrypoint and register entries that name a file which no longer exists. A
 * stale manifest is the other half of the ledger: it inflates the denominator
 * with coverage that is not there.
 */
export function staleManifestEntries(root: string): string[] {
  const onDisk = new Set([...vitestTestFilesOnDisk(root), ...browserSpecFilesOnDisk(root)])
  return [...manifestTestFiles(), ...packageScriptTestFiles(root)].filter(file => !onDisk.has(file)).sort()
}
