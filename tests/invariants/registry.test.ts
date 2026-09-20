/**
 * Consistency gate for the invariant registry.
 *
 * `npm run invariants:verify` proves each registered mutation turns its evidence
 * red. This proves the registry itself is not lying:
 *
 *   - the chokepoint, symbol and evidence file exist and resolve;
 *   - ids are unique and every row declares the audit it is supposed to
 *     (`uniqueness`, `overRejection`, `evidenceFailsWith`);
 *   - the uniqueness rules are live (each one matches the sample it names, and
 *     none of them exempts a whole scan root, which would make it unfireable);
 *   - a `requires` declaration is a claim about the evidence file, so it is read
 *     from that file: the evidence has to gate itself on the binding, or the row
 *     cannot use the declaration to be reported NOT RUN — and tolerated — by the
 *     gate while its guard is broken;
 *   - a registered evidence file is not one of the shapes that made the suite
 *     green through two audit rounds:
 *
 *       1. a source-string assertion (`readFileSync(...).toContain(...)`), which
 *          survives reverting the code it claims to guard,
 *       2. a mocked dependency, which cannot observe the SQL/Redis/compose
 *          artefact the invariant actually lives in,
 *       3. stubbing the chokepoint symbol itself, which replaces the code under
 *          test with whatever the test wanted it to say,
 *       4. an assertion that can be skipped — `it.skip`, `describe.skipIf`,
 *          `it.todo` — which reports as pending and leaves the run green.
 *
 * The patterns are deliberately narrow: they flag a registered evidence file,
 * not the whole suite. A file may still mock something unrelated. Each pattern
 * carries a sample it must match, because a pattern that matches nothing is a
 * check that cannot fail, and an empty check reads as a passing one — the exact
 * false confidence this file was written to remove.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { evidenceGatesOnBinding, unsupportedRequires, type InvariantMutation } from './registry.js'
import { findRuleMatches, missingAuditFields, ruleIsVacuous, ruleMatchesItsSample, scanFiles, symbolReferences } from './uniqueness.js'

const root = resolve(import.meta.dirname, '../..')
const fragmentDirectory = resolve(root, 'tests/invariants')

async function loadMutations(): Promise<{ mutations: InvariantMutation[]; fragments: string[] }> {
  const fragments = readdirSync(fragmentDirectory).filter(name => name.endsWith('.invariant.ts'))
  const mutations: InvariantMutation[] = []
  for (const name of fragments) {
    const module = (await import(pathToFileURL(join(fragmentDirectory, name)).href)) as { mutations?: InvariantMutation[] }
    mutations.push(...(module.mutations ?? []))
  }
  return { mutations, fragments }
}

/**
 * Extensions whose syntax is worth checking after a mutation is applied. A
 * shell or SQL mutation is not TypeScript and is skipped rather than guessed at.
 */
const PARSABLE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.js', '.mjs']

/**
 * Syntax errors only (codes 1xxx): option and configuration diagnostics are not
 * syntax, and would turn an unrelated compiler setting into a failed row.
 *
 * `createSourceFile` parses without emitting, which is all this needs — and is
 * an order of magnitude cheaper than transpiling the release-sized files
 * several rows mutate. `parseDiagnostics` is not in the public type declaration,
 * so the read is cast; the test below proves the detector is live, so a rename
 * cannot quietly turn it into a check that matches nothing.
 */
function syntaxErrors(file: string, source: string): string[] {
  const scriptKind = file.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : /\.(?:js|mjs|jsx)$/u.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, scriptKind) as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }
  return (parsed.parseDiagnostics ?? [])
    .filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error && diagnostic.code >= 1000 && diagnostic.code < 2000)
    .map(diagnostic => `${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`)
}

/** Shapes that made a guard green for the wrong reason on this branch. */
const FORBIDDEN_EVIDENCE_PATTERNS: { pattern: RegExp; sample: string; why: string }[] = [
  {
    pattern: /\b(?:readFileSync|readFile)\s*\([^)]*\)[\s\S]{0,400}?\.(?:toContain|toMatch|includes|indexOf)\(/u,
    sample: "expect(readFileSync('apps/api/src/server.ts', 'utf8')).toContain('generationJobWriteRefused')",
    why: 'source-string assertion: survives reverting the code it guards',
  },
  {
    // The obvious way past the pattern above, and the one an author reaches for
    // after being told not to assert on source text: rename the import.
    pattern: /\breadFileSync\s+as\s+\w+/u,
    sample: "import { readFileSync as sourceText } from 'node:fs'",
    why: 'a file read imported under an alias: the source-string assertion is still a source-string assertion, it just stopped matching the pattern that names it',
  },
  {
    pattern: /vi\.mock\(\s*['"][^'"]*['"]/u,
    sample: "vi.mock('../../../packages/persistence/src/storage-quota-repository.js')",
    why: 'module mock: the evidence cannot observe the SQL/Redis/compose artefact the invariant lives in',
  },
  {
    // `skipIf`/`runIf` are deliberately NOT matched: the PostgreSQL evidence
    // files bind on `PERSISTENCE_RELEASE_DATABASE_URL` that way, which is the
    // contract this gate satisfies. A skip that actually happened is caught at
    // run time instead — the mutation cannot turn a test that never ran red.
    pattern: /\b(?:it|test|describe)\.(?:skip|todo)\s*\(/u,
    sample: "it.skip('releases the reservation', () => {})",
    why: 'an unconditionally skipped assertion reports as pending and leaves the run green — "not run" must never read as "passed"',
  },
]

describe('invariant registry', () => {
  it('has fragments to check', async () => {
    const { fragments } = await loadMutations()
    expect(fragments.length, 'no *.invariant.ts fragments found — the registry is unpopulated').toBeGreaterThan(0)
  })

  it('has unique ids and well-formed rows', async () => {
    const { mutations } = await loadMutations()
    const ids = mutations.map(mutation => mutation.id)
    expect(new Set(ids).size, `duplicate invariant ids: ${ids.join(', ')}`).toBe(ids.length)
    for (const mutation of mutations) {
      expect(mutation.invariant.trim().length, `${mutation.id}: invariant statement is too short to be one`).toBeGreaterThan(20)
      expect(mutation.rationale.trim().length, `${mutation.id}: rationale is too short`).toBeGreaterThan(20)
      expect(mutation.find, `${mutation.id}: find and replace are identical, so the mutation is a no-op`).not.toBe(mutation.replace)
      expect(
        missingAuditFields(mutation),
        `${mutation.id}: the row is missing the audits that make it evidence rather than decoration`,
      ).toEqual([])
    }
  })

  it('points at chokepoints and evidence that exist', async () => {
    const { mutations } = await loadMutations()
    for (const mutation of mutations) {
      expect(existsSync(resolve(root, mutation.chokepoint)), `${mutation.id}: chokepoint missing: ${mutation.chokepoint}`).toBe(true)
      expect(existsSync(resolve(root, mutation.file)), `${mutation.id}: mutation file missing: ${mutation.file}`).toBe(true)
      expect(existsSync(resolve(root, mutation.evidence)), `${mutation.id}: evidence missing: ${mutation.evidence}`).toBe(true)
      const source = readFileSync(resolve(root, mutation.file), 'utf8')
      expect(
        source.split(mutation.find).length - 1,
        `${mutation.id}: the mutation anchor must occur exactly once in ${mutation.file}, otherwise the mutation is ambiguous`,
      ).toBe(1)
      const overRejection = mutation.overRejection!
      const overRejectionFile = overRejection.file ?? mutation.file
      const overRejectionSource = overRejectionFile === mutation.file ? source : readFileSync(resolve(root, overRejectionFile), 'utf8')
      expect(existsSync(resolve(root, overRejectionFile)), `${mutation.id}: over-rejection file missing: ${overRejectionFile}`).toBe(true)
      expect(
        overRejectionSource.split(overRejection.find).length - 1,
        `${mutation.id}: the over-rejection anchor must occur exactly once in ${overRejectionFile}`,
      ).toBe(1)
      const rule = mutation.ruleMutation
      if (rule) {
        expect(existsSync(resolve(root, rule.file)), `${mutation.id}: rule-mutation file missing: ${rule.file}`).toBe(true)
        expect(
          readFileSync(resolve(root, rule.file), 'utf8').split(rule.find).length - 1,
          `${mutation.id}: the rule-mutation anchor must occur exactly once in ${rule.file}`,
        ).toBe(1)
      }
    }
  })

  /**
   * A mutation has to leave source that still compiles. The failure this
   * catches, observed in this registry: the `closeRedisClient` fallback anchor
   * spanned the closing brace of its `catch`, so the replacement produced a
   * `try` with no `catch`/`finally`. The evidence then goes red with a
   * transform error, which the gate correctly refuses to score — it reports
   * NOT ATTRIBUTABLE — and the row can never be certified. That surfaced only
   * after minutes inside `npm run invariants:verify`; here it surfaces as a
   * failed row with the mutation named.
   */
  it('applies each mutation to a file that still parses', async () => {
    const { mutations } = await loadMutations()
    // A detector that reports nothing would certify every row above it, so
    // prove it still sees the shape this test exists for.
    expect(
      syntaxErrors('detector.ts', 'try { run() }'),
      'the syntax detector no longer reports a broken `try` — every mutation would be certified',
    ).not.toEqual([])
    const offenders: string[] = []
    for (const mutation of mutations) {
      const cases = [
        { kind: 'mutation', file: mutation.file, find: mutation.find, replace: mutation.replace },
        ...(mutation.overRejection ? [{ kind: 'overRejection', file: mutation.overRejection.file ?? mutation.file, find: mutation.overRejection.find, replace: mutation.overRejection.replace }] : []),
        ...(mutation.ruleMutation ? [{ kind: 'ruleMutation', file: mutation.ruleMutation.file, find: mutation.ruleMutation.find, replace: mutation.ruleMutation.replace }] : []),
      ]
      for (const { kind, file, find, replace } of cases) {
        if (!PARSABLE_EXTENSIONS.some(extension => file.endsWith(extension))) continue
        const source = readFileSync(resolve(root, file), 'utf8')
        if (syntaxErrors(file, source).length) {
          offenders.push(`${mutation.id} [${kind}]: ${file} does not parse before the mutation`)
          continue
        }
        // The anchor is asserted to occur once by the test above; a mutation
        // that replaces nothing is that test's finding, not this one.
        const errors = syntaxErrors(file, source.split(find).join(replace))
        if (errors.length) offenders.push(`${mutation.id} [${kind}]: the replacement leaves ${file} unparsable (${errors[0]})`)
      }
    }
    expect(offenders, 'a mutation that does not compile is not a guard: the evidence can only fail with a transform error, which the gate scores as NOT ATTRIBUTABLE rather than as the named assertion').toEqual([])
  })

  it('resolves every chokepointSymbol in the repository', async () => {
    const { mutations } = await loadMutations()
    const files = scanFiles(root)
    for (const mutation of mutations) {
      const symbol = mutation.chokepointSymbol!
      const references = symbolReferences(root, symbol, files)
      expect(
        references.length,
        `${mutation.id}: ${symbol} is referenced by no file — the symbol the row enforces through does not exist under that name`,
      ).toBeGreaterThan(0)
      expect(
        references,
        `${mutation.id}: ${symbol} is not referenced by its own chokepoint`,
      ).toContain(mutation.chokepoint)
    }
  })

  it('certifies one implementation per invariant, not just the one the evidence watches', async () => {
    const { mutations } = await loadMutations()
    const offenders: string[] = []
    for (const mutation of mutations) {
      const uniqueness = mutation.uniqueness!
      for (const rule of uniqueness.noSecondImplementation) {
        expect(ruleMatchesItsSample(rule), `${mutation.id}: /${rule.pattern}/ does not match the sample it declares (${rule.sample}), so it cannot be catching anything`).toBe(true)
        expect(ruleIsVacuous(rule), `${mutation.id}: /${rule.pattern}/ exempts a whole scan root, so it can never fire (${rule.why})`).toBe(false)
        for (const match of findRuleMatches(root, rule)) {
          offenders.push(`${mutation.id}: second implementation at ${match.file}:${match.line} — ${match.text} (${rule.why})`)
        }
      }
      if (uniqueness.callers) {
        for (const file of symbolReferences(root, mutation.chokepointSymbol!)) {
          if (file === mutation.chokepoint || /\.(test|spec)\.tsx?$/u.test(file)) continue
          if (uniqueness.callers.includes(file)) continue
          offenders.push(`${mutation.id}: ${file} calls ${mutation.chokepointSymbol} without being listed in uniqueness.callers — re-audit the enumeration`)
        }
      }
    }
    expect(
      offenders,
      'a registered invariant has more than one implementation, so the mutation below it proves nothing about the sentence it claims to guard',
    ).toEqual([])
  })

  /**
   * `requires` is the one field that makes a claim about a *different* file, and
   * nothing checked it. The gate took the claim on faith, so a broken guard
   * could be turned from a red into a tolerated NOT RUN — exit 1 into exit 0 on
   * a machine where the fixture could not start — by adding
   * `requires: 'PERSISTENCE_RELEASE_DATABASE_URL'` to a row whose evidence never
   * mentions that binding. Auditing it here means the unsupported declaration is
   * a registry defect that fails the suite, not only a hole on somebody's
   * Docker-less laptop.
   */
  it('only accepts a requires declaration the evidence file gates itself on', async () => {
    const { mutations } = await loadMutations()
    // Proved in both directions first: a check that reports nothing certifies
    // every row above it.
    const gated = "const databaseUrl = process.env.PERSISTENCE_RELEASE_DATABASE_URL\nconst postgresIt = databaseUrl ? it : it.skip"
    expect(evidenceGatesOnBinding(gated, 'PERSISTENCE_RELEASE_DATABASE_URL'), 'the detector no longer sees a binding read in a skip guard').toBe(true)
    expect(evidenceGatesOnBinding("import { it } from 'vitest'", 'PERSISTENCE_RELEASE_DATABASE_URL'), 'the detector accepts an evidence file that never reads the binding').toBe(false)
    expect(evidenceGatesOnBinding(gated, 'REDIS_URL'), 'the detector accepts any binding name, not the one the evidence reads').toBe(false)

    const offenders: string[] = []
    for (const mutation of mutations) {
      const unsupported = unsupportedRequires(mutation, readFileSync(resolve(root, mutation.evidence), 'utf8'))
      if (unsupported) offenders.push(`${mutation.id}: ${unsupported}`)
    }
    expect(
      offenders,
      'a row claims a binding its own evidence does not gate itself on — the gate would report it NOT RUN and `npm run check` would tolerate it, which turns a broken guard into a non-finding',
    ).toEqual([])
  })

  it('rejects evidence that guards by string match, by mocking, or by skipping', async () => {
    const { mutations } = await loadMutations()
    // A pattern that matches nothing is a check that cannot fail, and an empty
    // check reads as a passing one. Prove each one still catches its shape
    // before trusting it against the registered files.
    for (const { pattern, sample, why } of FORBIDDEN_EVIDENCE_PATTERNS) {
      expect(pattern.test(sample), `the forbidden-evidence pattern for "${why}" no longer matches its own sample: ${sample}`).toBe(true)
    }
    const offenders: string[] = []
    for (const mutation of mutations) {
      const source = readFileSync(resolve(root, mutation.evidence), 'utf8')
      const stubsChokepoint = new RegExp(`vi\\.(?:spyOn|mock)\\s*\\([^)]*\\b${(mutation.chokepointSymbol ?? '').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'u')
      for (const { pattern, why } of FORBIDDEN_EVIDENCE_PATTERNS) {
        if (pattern.test(source)) offenders.push(`${mutation.id} (${mutation.evidence}): ${why}`)
      }
      if (stubsChokepoint.test(source)) offenders.push(`${mutation.id} (${mutation.evidence}): stubs ${mutation.chokepointSymbol} — the evidence replaces the code it is supposed to be testing`)
    }
    expect(
      offenders,
      'a registered evidence file is one of the shapes that stayed green through two audit rounds — replace it with a behaviour assertion against a real dependency, or move the invariant out of the registry',
    ).toEqual([])
  })
})
