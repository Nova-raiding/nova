/**
 * Cross-module invariant registry.
 *
 * The failure this exists for, twice observed on this branch: an invariant is
 * implemented by hand at several call sites, a fix repairs one of them, and the
 * guard that is supposed to prove it lives at the wrong layer — a source-string
 * assertion, a mocked response, or a scan that only covers one configuration
 * layer. Each round therefore closes one call path and leaves its siblings
 * asymmetric, and the suite stays green through all of it.
 *
 * The two audit rounds found exactly this shape in the reservation-key ledger,
 * the wallet settlement amount, the brand predicate, the generation terminal
 * guard, the Redis close semantics and the release-chain required variables.
 * The second round then fixed *other call sites of the first round's defects* —
 * which is the proof that patching call sites does not converge.
 *
 * So each invariant gets one row here, and the row has to name:
 *
 *   - the single chokepoint that implements it (no second copy anywhere),
 *   - a mutation that breaks the guard,
 *   - an evidence test that must FAIL once the mutation is applied, running
 *     against a real dependency (real PostgreSQL, real node-redis, a real
 *     rendered Compose file) rather than a mock or a string match.
 *
 * `npm run invariants:verify` applies every mutation and asserts the evidence
 * goes red — and, since the third audit round, asserts three more things that
 * "the evidence went red" quietly assumed without checking:
 *
 *   - `uniqueness` — the sentence has one implementation, not just one the
 *     evidence happens to watch;
 *   - `overRejection` — the evidence fails when the guard refuses the writes it
 *     is supposed to allow, not only when it allows the writes it should refuse;
 *   - `evidenceFailsWith` — the red came from the named assertion rather than a
 *     timeout, a crash or an unrelated flake.
 *
 * An invariant without a chokepoint is a design problem, not a testing problem:
 * prefer collapsing the copies into one exported function over registering a
 * row that has to watch three of them.
 */

/**
 * A pattern that must not appear outside `allow`.
 *
 * This is the uniqueness half of the registry. A mutation proves that *this*
 * implementation is load-bearing; it says nothing about whether a second
 * implementation of the same sentence exists three files away, which is exactly
 * how this branch failed four times. Each row therefore also names the text a
 * re-implementation is made of, and the audit fails the row when that text
 * appears anywhere the chokepoint does not own.
 */
export interface UniquenessRule {
  /** Regex source, applied line by line to every scanned file. */
  pattern: string
  /** Flags; `u` is always applied. */
  flags?: string
  /**
   * A minimal snippet of the shape this rule is written for. The audit asserts
   * the pattern still matches it, so a pattern that was widened, narrowed or
   * typo'd into matching nothing fails loudly instead of certifying the row.
   */
  sample: string
  /**
   * Also scan test files. Off by default: a test that seeds a row with the
   * same literal is fixture data, not an implementation. On for the rules whose
   * target is precisely a *test* that recomputes the rule.
   */
  includeTests?: boolean
  /** Repo-relative files or directories exempted, e.g. the chokepoint itself. */
  allow: readonly string[]
  /** What a match means, in one sentence. */
  why: string
}

export interface UniquenessCheck {
  /**
   * Production files (outside the chokepoint) that are allowed to reference
   * `chokepointSymbol`. Any other one is a call site that joined after the row
   * was audited, and it fails until the enumeration is brought up to date.
   * Omitted when the call set is genuinely open (a method every worker calls);
   * the pattern rules below still apply.
   */
  callers?: readonly string[]
  /**
   * Text a second implementation of this invariant is written in. Must match
   * nothing outside `allow` — not "should", must: a match anywhere else means
   * the sentence in `invariant` has more than one implementation and the gate
   * cannot certify it.
   */
  noSecondImplementation: readonly UniquenessRule[]
}

export interface InvariantMutation {
  /** Stable kebab-case id, unique across the registry. */
  id: string
  /** The invariant in one sentence, stated as something that must always hold. */
  invariant: string
  /**
   * The one place that enforces the invariant, as a repo-relative **path**.
   * If a second implementation exists anywhere, the invariant is not enforced
   * and this row is wrong. The gate asserts this path exists, so prose here
   * fails the registry rather than passing unread — name the symbol in
   * `chokepointSymbol` instead.
   */
  chokepoint: string
  /**
   * The exported name inside `chokepoint` that callers must go through. Read by
   * the uniqueness audit, which resolves it in the repository: a symbol that
   * no file references means the chokepoint is a declaration nobody uses, and
   * a file that references it without being listed in `uniqueness.callers`
   * means a call site joined after the audit. Optional in the type so a row
   * added concurrently cannot break the build; a row that omits it is reported
   * by `missingAuditFields` rather than accepted.
   */
  chokepointSymbol?: string
  /** File the mutation is applied to. Usually the chokepoint. */
  file: string
  /** Exact substring to replace. Must occur exactly once in `file`. */
  find: string
  /** What the mutation replaces it with — the regression being guarded against. */
  replace: string
  /**
   * The same guard mutated in the *opposite* direction: over-rejecting instead
   * of under-rejecting. Evidence that only turns red here is one-sided — it
   * proves the bad input is refused and says nothing about the good input being
   * let through, so a guard that refuses everything would pass it.
   *
   * Optional in the type so a row added concurrently cannot break the build;
   * a row that omits it is failed by `registry.test.ts` and by the gate with
   * "the row declares no overRejection mutation", never silently accepted.
   */
  overRejection?: {
    /** File to mutate; defaults to `file`. */
    file?: string
    find: string
    replace: string
    /** Why refusing everything is the same defect as accepting everything. */
    why: string
  }
  /**
   * A substring the evidence output must contain when it fails under this
   * mutation. The gate no longer scores "the process exited non-zero" as proof:
   * a timeout, a missing module or an unrelated flake is reported as
   * NOT ATTRIBUTABLE. This is the expected assertion, and it has to appear.
   * Omitting it fails the row at audit time rather than passing it.
   */
  evidenceFailsWith?: string
  /** Test file that must fail once the mutation is applied. */
  evidence: string
  /**
   * Breaks the *rule* rather than the code — the scanner, oracle or helper the
   * evidence reads its definition from — and the gate requires that it erases
   * the detection: with the code mutation still in place, the evidence must go
   * back to GREEN. An evidence file that re-implements the definition instead
   * of consuming it keeps failing, which is how `release-env` certified a
   * narrowed scanner.
   */
  ruleMutation?: {
    file: string
    find: string
    replace: string
    why: string
  }
  /**
   * Uniqueness audit for this chokepoint. See `UniquenessCheck`. Optional in
   * the type for the same reason as `overRejection`; omitting it makes the row
   * report as unaudited.
   */
  uniqueness?: UniquenessCheck
  /**
   * Environment the evidence needs (e.g. `PERSISTENCE_RELEASE_DATABASE_URL`).
   * Recorded so a skip reads as "not run" rather than as "passed".
   *
   * This is a claim about the *evidence file*, so it is checked against that
   * file and not taken on faith: the evidence must read `process.env.<binding>`
   * in a skip guard (`skipIf`/`runIf`/`it.skip`), or the declaration is
   * unsupported and the row runs anyway — see `unsupportedRequires`. Declaring a
   * binding the evidence does not use used to be enough to turn a broken guard
   * from red into a tolerated NOT RUN.
   */
  requires?: string
  /** Why this mutation is the one that matters. */
  rationale: string
}

/**
 * Fragments are contributed per-invariant (one file each) so two authors never
 * edit the same list. `registry.test.ts` loads every `*.invariant.ts` here.
 */
export interface InvariantFragment {
  mutations: readonly InvariantMutation[]
}

/* ------------------------------------------------------------------ *
 * `requires` — a claim about another file, so it is read from that file
 * ------------------------------------------------------------------ */

/**
 * Whether an evidence file gates itself on an environment binding.
 *
 * `requires` is unlike every other field on a row: it is a claim about a
 * *different* file — that the evidence cannot run without the binding, so a run
 * without it reports NOT RUN rather than a pass. Nothing read it, and the claim
 * decided the verdict: a row whose guard was broken only had to add
 * `requires: 'PERSISTENCE_RELEASE_DATABASE_URL'` to be reported NOT RUN and
 * *tolerated* by `npm run check` on a machine where the fixture could not start.
 * The same broken code was fatal without the field — one declaration, and the
 * gate went from exit 1 to exit 0. A field that decides a verdict is the exact
 * failure this registry exists to remove, so the declaration now has to be
 * visible in the file it makes a claim about: the evidence reads the binding and
 * uses it to decide whether to skip.
 */
export function evidenceGatesOnBinding(source: string, binding: string): boolean {
  const escaped = binding.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const read = new RegExp(`process\\.env(?:\\.${escaped}\\b|\\[\\s*['"\`]${escaped}['"\`]\\s*\\])`, 'u')
  if (!read.test(source)) return false
  return /\bskipIf\b|\brunIf\b|\b(?:it|test|describe)\.skip\b/u.test(source)
}

/**
 * Why a row's `requires` declaration is unsupported by its own evidence, or
 * `undefined` when the evidence really is gated on the binding.
 *
 * Read by `registry.test.ts` (so the unsupported declaration fails the suite
 * rather than only the machine that happens to lack the fixture) and by the gate
 * (so a row cannot excuse itself from running).
 */
export function unsupportedRequires(
  mutation: Pick<InvariantMutation, 'requires' | 'evidence'>,
  evidenceSource: string,
): string | undefined {
  const binding = mutation.requires?.trim()
  if (!binding) return undefined
  if (evidenceGatesOnBinding(evidenceSource, binding)) return undefined
  return `declares requires: ${binding}, but ${mutation.evidence} never reads process.env.${binding} to decide whether to skip (no skipIf/runIf/it.skip next to it), so the declaration cannot excuse the row from running`
}
