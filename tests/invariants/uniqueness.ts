import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { InvariantMutation, UniquenessRule } from './registry.js'

/**
 * The uniqueness audit.
 *
 * `npm run invariants:verify` proves that breaking a guard turns its evidence
 * red. That is a statement about one implementation; it is not a statement that
 * the *sentence* has only one implementation. The branch produced four of the
 * latter — a wallet amount derived twice, a brand predicate in three places, a
 * terminal-state test in two, a ledger key derived by hand a second time — and
 * the mutation gate scored every one of them green, because each mutation
 * happened to hit the copy the evidence was watching.
 *
 * So every row also declares what a *second* implementation of its sentence is
 * made of, and this module greps the repository for it. Two checks, read by
 * `registry.test.ts` (normal suite) and by the gate (merge evidence):
 *
 *   1. every production file outside `chokepoint` that names `chokepointSymbol`
 *      must be listed in `uniqueness.callers` — a call site that joined after
 *      the audit is a row whose enumeration is out of date, and it fails until
 *      it is re-audited;
 *   2. no `noSecondImplementation` pattern may match outside its `allow` list —
 *      the text a re-implementation is written in is what is grepped, so adding
 *      one back is caught without anyone having to think of the case again.
 *
 * The audit is not allowed to be vacuous. A row whose symbol nothing consumes
 * is a declaration, not an enforcement point — `chokepointSymbol` sat in this
 * registry unread for a whole round — and a rule set that matches nothing and
 * exempts everything certifies nothing.
 */

/** Directories walked for the audit. */
const SCAN_ROOTS: readonly string[] = ['apps', 'packages', 'scripts', 'infra', 'tests']
/** Extensions the audit treats as implementation or configuration text. */
const SCAN_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.mjs', '.js', '.sql', '.sh', '.yaml', '.yml', '.env']
/** Never scanned: build output, vendored trees, generated evidence. */
const SCAN_SKIP: readonly string[] = ['node_modules', 'dist', 'build', '.git', 'artifacts', 'coverage', 'screenshots']

/** Reads a repo-relative file once per process; the audit touches each file many times. */
const contents = new Map<string, string>()

export function readScanned(root: string, file: string): string {
  const cached = contents.get(file)
  if (cached !== undefined) return cached
  const text = readFileSync(resolve(root, file), 'utf8')
  contents.set(file, text)
  return text
}

let cachedFiles: string[] | undefined

/** Every scan-eligible file, repo-relative and sorted. */
export function scanFiles(root: string): string[] {
  cachedFiles ??= SCAN_ROOTS.flatMap(entry => walk(root, entry)).sort()
  return cachedFiles
}

function walk(root: string, relative: string): string[] {
  const absolute = resolve(root, relative)
  let stat
  try { stat = statSync(absolute) } catch { return [] }
  if (stat.isFile()) return SCAN_EXTENSIONS.some(extension => relative.endsWith(extension)) ? [relative] : []
  const segments = relative.split('/')
  if (SCAN_SKIP.some(skip => segments.includes(skip))) return []
  return readdirSync(absolute, { withFileTypes: true })
    .flatMap(entry => walk(root, `${relative}/${entry.name}`))
}

/** True when `file` is `allowed`, sits inside an allowed directory, or is a test/build sibling of one. */
export function isAllowed(file: string, allow: readonly string[]): boolean {
  return allow.some(entry => {
    const normalized = entry.replace(/\/+$/u, '')
    return file === normalized || file.startsWith(`${normalized}/`) || normalized.startsWith(`${file}/`)
  })
}

export interface PatternMatch { file: string; line: number; text: string }

function ruleExpression(rule: Pick<UniquenessRule, 'pattern' | 'flags'>): RegExp {
  const flags = rule.flags ?? ''
  const expression = new RegExp(rule.pattern, flags.includes('u') ? flags : `${flags}u`)
  if (!(expression.flags.includes('g') || expression.flags.includes('y'))) return expression
  // A stray `g` would make `test` stateful and silently skip lines.
  return new RegExp(rule.pattern, expression.flags.replace(/[gy]/gu, ''))
}

/**
 * Files a rule scans: everything eligible, minus the registry's own fragments
 * (a row quotes the shape it forbids, which is not an implementation) and, by
 * default, test files (a test seeding a ledger row with the same literal is
 * fixture data). `includeTests` opts a rule into test files, for the rules
 * whose target is a test that recomputes the definition.
 */
export function ruleScanFiles(root: string, rule: UniquenessRule, files: readonly string[] = scanFiles(root)): string[] {
  return files.filter(file => {
    if (/^tests\/invariants\/(?:.*\.invariant|registry\.test)\.ts$/u.test(file)) return false
    if (!rule.includeTests && isTestFile(file)) return false
    return true
  })
}

/** Every line outside `rule.allow` matching `rule.pattern`. */
export function findRuleMatches(root: string, rule: UniquenessRule, files: readonly string[] = scanFiles(root)): PatternMatch[] {
  const expression = ruleExpression(rule)
  const matches: PatternMatch[] = []
  for (const file of ruleScanFiles(root, rule, files)) {
    if (isAllowed(file, rule.allow)) continue
    for (const [index, text] of readScanned(root, file).split('\n').entries()) {
      expression.lastIndex = 0
      if (expression.test(text)) matches.push({ file, line: index + 1, text: text.trim().slice(0, 160) })
    }
  }
  return matches
}

/**
 * Whether the rule's shape exists anywhere at all, exempt lists ignored. A rule
 * whose pattern was written against code that has since moved matches nothing
 * and audits nothing, so the row is reported instead of certifying on it.
 */
export function ruleMatchesAnywhere(root: string, rule: UniquenessRule, files: readonly string[] = scanFiles(root)): boolean {
  const expression = ruleExpression(rule)
  return ruleScanFiles(root, rule, files).some(file =>
    readScanned(root, file).split('\n').some(text => { expression.lastIndex = 0; return expression.test(text) }))
}

/**
 * A rule exempting a whole scan root is not auditing anything: whatever a
 * second implementation is written into, it will be in `apps`, `packages`,
 * `tests` or `scripts`, and a rule that allows all of them can never fire.
 */
export function ruleIsVacuous(rule: UniquenessRule): boolean {
  return rule.allow.some(entry => SCAN_ROOTS.includes(entry.replace(/\/+$/u, '')))
}

/** True when the rule's pattern still matches the snippet it says it is written for. */
export function ruleMatchesItsSample(rule: UniquenessRule): boolean {
  return ruleExpression(rule).test(rule.sample)
}

function escapeSymbol(symbol: string): string {
  return symbol.replace(/[$]/gu, '\\$&')
}

/** Every scanned file that references `symbol` as a word, excluding the registry's own fragments. */
export function symbolReferences(root: string, symbol: string, files: readonly string[] = scanFiles(root)): string[] {
  const lastSegment = symbol.split('.').pop()!
  if (!/^[A-Za-z_$][\w$]*$/u.test(lastSegment)) throw new Error(`uniqueness: not a symbol name: ${symbol}`)
  const expression = new RegExp(`\\b${escapeSymbol(lastSegment)}\\b`, 'u')
  return files.filter(file => {
    // The registry's own fragments name every symbol; they are not callers. The
    // oracle modules under tests/invariants (release-env-closure.ts) are.
    if (/^tests\/invariants\/.*\.invariant\.ts$/u.test(file) || file === 'tests/invariants/registry.test.ts') return false
    return expression.test(readScanned(root, file))
  })
}

export interface UniquenessFinding {
  id: string
  summary: string
}

export interface UniquenessAudit {
  /** Rows whose sentence has exactly one implementation, as far as the audit can see. */
  certified: string[]
  /** Rows that fail: a second implementation, an unlisted caller, or a symbol nothing consumes. */
  violations: UniquenessFinding[]
  /** Rows that pass without checking anything. */
  vacuous: UniquenessFinding[]
}

function isTestFile(file: string): boolean {
  return /\.(test|spec)\.tsx?$/u.test(file)
}

/**
 * Audit fields a row has not declared. They are optional in the type so a row
 * added by another author mid-flight cannot break the build for everyone, but
 * a row that omits one is failed rather than accepted: "not checked" must not
 * read as "checked and fine", which is the failure mode this whole registry
 * exists to correct.
 */
export function missingAuditFields(mutation: InvariantMutation): string[] {
  const missing: string[] = []
  if (!mutation.chokepointSymbol?.trim()) missing.push('chokepointSymbol')
  if (!mutation.uniqueness) missing.push('uniqueness')
  if (!mutation.overRejection) missing.push('overRejection')
  if (!mutation.evidenceFailsWith) missing.push('evidenceFailsWith')
  return missing
}

export function auditUniqueness(root: string, mutations: readonly InvariantMutation[]): UniquenessAudit {
  const files = scanFiles(root)
  const audit: UniquenessAudit = { certified: [], violations: [], vacuous: [] }
  for (const mutation of mutations) {
    const gaps = missingAuditFields(mutation)
    if (gaps.length) {
      audit.vacuous.push({ id: mutation.id, summary: `    the row declares no ${gaps.join(', ')} — nothing about this chokepoint is audited` })
      continue
    }
    const { callers, noSecondImplementation } = mutation.uniqueness!
    const violations: string[] = []
    if (!mutation.chokepointSymbol?.trim()) {
      audit.vacuous.push({ id: mutation.id, summary: '    the row names no chokepointSymbol, so nothing about its enforcement point is resolved in the repository' })
      continue
    }
    const references = symbolReferences(root, mutation.chokepointSymbol, files)

    // A chokepoint symbol that resolves nowhere is prose in a field, which is
    // what `chokepointSymbol` was for a whole round: declared, never read.
    if (!references.length) violations.push(`${mutation.chokepointSymbol} is not referenced by any file — the symbol this row enforces through does not exist under that name`)
    else if (!references.includes(mutation.chokepoint)) violations.push(`${mutation.chokepointSymbol} is not referenced by its own chokepoint ${mutation.chokepoint}`)
    if (callers) {
      for (const file of references) {
        if (file === mutation.chokepoint || isTestFile(file)) continue
        if (isAllowed(file, callers)) continue
        violations.push(`${file} calls ${mutation.chokepointSymbol} without being listed in uniqueness.callers — re-audit the row's enumeration`)
      }
    }

    for (const rule of noSecondImplementation) {
      for (const match of findRuleMatches(root, rule, files)) {
        violations.push(`second implementation at ${match.file}:${match.line} — ${match.text} (${rule.why})`)
      }
    }

    const summary = violations.map(violation => `    ${violation}`).join('\n')
    const deadRules = noSecondImplementation.filter(rule => ruleIsVacuous(rule) || !ruleMatchesItsSample(rule))
    if (violations.length) audit.violations.push({ id: mutation.id, summary })
    else if (!noSecondImplementation.length || deadRules.length) {
      const reasons = deadRules.map(rule => `    /${rule.pattern}/ does not match its own sample or exempts a whole scan root, so it audits nothing (${rule.why})`)
      audit.vacuous.push({ id: mutation.id, summary: reasons.length ? reasons.join('\n') : `    no noSecondImplementation rule is registered, so nothing about this chokepoint is unique beyond the mutation` })
    } else audit.certified.push(mutation.id)
  }
  return audit
}

/**
 * Rules that match nothing in the repository today.
 *
 * A rule is allowed to be preventive — the shape it forbids is a regression
 * that must not come back, and grepping for it is how the row would catch it.
 * What this list is for is the *other* case: a rule written against code that
 * has since moved, which now audits a shape that no longer exists. The gate
 * prints it; a human decides which of the two it is.
 */
export function unmatchedRules(root: string, mutations: readonly InvariantMutation[], files: readonly string[] = scanFiles(root)): { id: string; pattern: string; why: string }[] {
  const unmatched: { id: string; pattern: string; why: string }[] = []
  for (const mutation of mutations) {
    for (const rule of mutation.uniqueness?.noSecondImplementation ?? []) {
      if (!ruleMatchesAnywhere(root, rule, files)) unmatched.push({ id: mutation.id, pattern: rule.pattern, why: rule.why })
    }
  }
  return unmatched
}
