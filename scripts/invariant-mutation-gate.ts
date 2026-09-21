/**
 * Invariant mutation gate.
 *
 * A guard is only a guard if removing it turns something red. This runner takes
 * every registered invariant, applies its mutation to the working tree, runs the
 * evidence test, and reports a row as OK only when the evidence failed *for the
 * reason the row names* — and only after the file was put back and the evidence
 * ran green again from the restored tree.
 *
 * Three things this gate refuses to score as a proof, each of them observed on
 * this branch:
 *
 *   1. **A non-zero exit is not a proof.** A timeout, a missing module, a flake
 *      and a genuine assertion failure all look the same to `catch {}`. Every
 *      row declares `evidenceFailsWith`, and a run whose output does not carry
 *      it is `NOT ATTRIBUTABLE`, never OK.
 *   2. **A red in one direction is not a proof of a guard.** Evidence that only
 *      shows the bad input being refused also passes when the guard refuses
 *      *everything*. Each row's `overRejection` mutation is applied and must
 *      turn the same evidence red.
 *   3. **Breaking the code is not proof that the *rule* matters.** Where the
 *      evidence reads its definition from a scanner or oracle, the row's
 *      `ruleMutation` breaks that definition as well, and the evidence must go
 *      back to GREEN: an evidence file that re-implements the definition keeps
 *      failing, and that is how a narrowed scanner certified a code mutation it
 *      no longer covered.
 *
 * It also refuses to certify uniqueness it has not checked: the registry rows
 * carry `uniqueness` rules, audited against the whole repository before any
 * mutation runs (see `tests/invariants/uniqueness.ts`). A row whose sentence has
 * a second implementation anywhere is reported as such.
 *
 * Usage:
 *   npm run invariants:verify              # every registered invariant
 *   npm run invariants:verify -- <id>      # one, by id or id prefix
 *   npm run invariants:verify -- --explain # print why a run failed to attribute
 *   npm run invariants:check               # what `npm run check` runs
 *
 * Concurrency: `npm run check` runs this gate, so it now runs while other work
 * may be in progress. It edits the working tree in place and takes an exclusive
 * lock, so a second run waits instead of interleaving, and a file that changes
 * while a mutation is applied is *refused* a restore — reported for manual
 * repair rather than silently reverted. In a shared worktree, do not edit a file
 * this gate mutates while `check` is running; the registry (`tests/invariants/`)
 * names every one of them.
 *
 * `invariants:check` adds `--tolerate-missing-bindings`: rows whose declared
 * PostgreSQL binding is unset, whose owned fixture could not be created, and
 * whose evidence was *observed* to stand down without it are reported as NOT
 * RUN — named, counted and explicitly excluded from the headline — instead of
 * failing a machine that has no Docker daemon. A row that FAILS, or that cannot
 * even run its baseline, is fatal in both modes, so the tolerance cannot hide a
 * broken guard; it only stops "no database here" from being reported as either
 * a pass or a branch failure. An evidence file is not tolerated just because
 * nothing could start it: the observation runs the evidence under a
 * configuration that loads without the binding, so "the file is broken" is a
 * FAIL that no amount of missing infrastructure excuses (see
 * `observeWithoutBinding`).
 *
 * The tolerance is not extended to a row's own say-so. `requires` is a claim
 * about the evidence file, and it used to be the whole test: a row whose guard
 * was broken added `requires: 'PERSISTENCE_RELEASE_DATABASE_URL'` to its entry
 * and was reported NOT RUN — tolerated, exit 0 — on a machine whose fixture
 * could not start, while the identical broken code without the field was exit 1.
 * One declaration decided whether a broken guard was fatal. So a blocked row now
 * has to *show* it is blocked, twice over: its evidence must read the binding in
 * a skip guard (see `unsupportedRequires`), and, when it does, the evidence is
 * run and has to report every collected assertion skipped. A row that declares a
 * binding it does not use, or that reads it somewhere that decides nothing, runs
 * like every other row and its mutation is applied.
 *
 * Evidence tests needing a real dependency are run against an owned, isolated
 * PostgreSQL fixture created for this run when the binding is not already
 * exported (the same fixture the isolated acceptance runner uses). If the
 * fixture cannot be created, a row reports `NOT RUN` only when its evidence was
 * observed to stand down without the binding, and the headline says exactly
 * that, rather than counting a skipped evidence file as a passing one — or a
 * broken one as a machine that merely lacks a database.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import { EVERY_ASSERTION_SKIPPED, stripAnsi, unsupportedRequires, type InvariantMutation } from '../tests/invariants/registry.js'
import { auditUniqueness, type UniquenessAudit } from '../tests/invariants/uniqueness.js'

const root = resolve(import.meta.dirname, '..')
const fragmentDirectory = resolve(root, 'tests/invariants')
const lockPath = join(root, '.invariants-verify.lock')
const explain = process.argv.includes('--explain')
const skipPostgres = process.env.INVARIANTS_SKIP_POSTGRES === '1'
/**
 * `check` runs the gate with this flag: rows whose only problem is a missing
 * PostgreSQL binding report NOT RUN and do not fail the run, so a machine
 * without Docker can still finish `check`. The strict default — what
 * `invariants:verify` and CI run — keeps NOT RUN fatal.
 */
const tolerateMissingBindings = process.argv.includes('--tolerate-missing-bindings')
const evidenceTimeoutMs = readPositiveInteger(process.env.INVARIANTS_EVIDENCE_TIMEOUT_MS, 120_000)

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

async function loadMutations(): Promise<InvariantMutation[]> {
  const files = readdirSync(fragmentDirectory).filter(name => name.endsWith('.invariant.ts'))
  const mutations: InvariantMutation[] = []
  for (const name of files) {
    const module = (await import(pathToFileURL(join(fragmentDirectory, name)).href)) as { mutations?: InvariantMutation[] }
    for (const mutation of module.mutations ?? []) mutations.push(mutation)
  }
  return mutations
}

/* ------------------------------------------------------------------ *
 * Working-tree safety
 * ------------------------------------------------------------------ */

/**
 * Files mutated right now, with the exact bytes that were written. The
 * `written` copy is what makes the restore safe in a shared worktree: if the
 * file on disk is no longer what this run put there, another process edited it,
 * and writing the stale `original` back would silently revert that work.
 */
const inFlight = new Map<string, { original: string; written: string }>()

function applyReplacements(file: string, replacements: readonly { find: string; replace: string }[]): { restore: () => void } {
  const path = resolve(root, file)
  const original = readFileSync(path, 'utf8')
  if (inFlight.has(file)) throw new Error(`already mutated in this run: ${file}`)
  let written = original
  for (const { find, replace } of replacements) {
    const occurrences = written.split(find).length - 1
    if (occurrences !== 1) {
      if (process.env.INVARIANTS_DEBUG) console.error(`[debug] ${file}: ${original.length} bytes, find=${JSON.stringify(find).slice(0, 80)}, has=${original.includes(find)}`)
      throw new Error(`mutation anchor occurs ${occurrences} times in ${file} (needs exactly 1)`)
    }
    // split/join rather than String.replace: the replacement is source code, and
    // `replace` gives `$$`, `$&`, `` $` `` and `$'` special meaning. A mutation
    // that writes a template literal back — `$${...}` — was silently rewritten,
    // which made the row fail for a reason that had nothing to do with the guard.
    written = written.split(find).join(replace)
  }
  inFlight.set(file, { original, written })
  writeFileSync(path, written)
  return {
    restore() {
      restoreFile(file)
    },
  }
}

/**
 * Puts one file back, and only if nobody else has touched it since.
 * Returns nothing: a file that cannot be restored safely is reported, never
 * overwritten with stale text.
 */
function restoreFile(file: string): void {
  const entry = inFlight.get(file)
  if (!entry) return
  const path = resolve(root, file)
  const onDisk = readFileSync(path, 'utf8')
  inFlight.delete(file)
  if (onDisk !== entry.written) {
    console.error(`\ninvariant gate: REFUSING to restore ${file} — it changed while the mutation was applied (another process wrote to it). Left as is; check it by hand.`)
    return
  }
  writeFileSync(path, entry.original)
  if (readFileSync(path, 'utf8') !== entry.original) throw new Error(`restore verification failed for ${file}`)
}

function restoreAll(): void {
  for (const file of [...inFlight.keys()]) {
    try { restoreFile(file) } catch (error) {
      console.error(`invariant gate: failed to restore ${file}: ${error instanceof Error ? error.message : error}`)
    }
  }
}

let releasing: (() => void) | undefined
let interrupted = false

/**
 * `timeout` sends SIGTERM, which the previous version did not handle: the
 * mutated file stayed in the tree and the lock was held for the full 30 minutes,
 * so the next run waited half an hour on a dead process. Every termination
 * signal now restores first, and the lock is released with it.
 */
function installTerminationHandlers(): void {
  const terminate = (signal: NodeJS.Signals, code: number) => {
    if (interrupted) process.exit(code)
    interrupted = true
    restoreAll()
    releasing?.()
    process.exit(code)
  }
  process.on('SIGINT', () => terminate('SIGINT', 130))
  process.on('SIGTERM', () => terminate('SIGTERM', 143))
  process.on('SIGHUP', () => terminate('SIGHUP', 129))
  process.on('exit', () => { restoreAll(); releasing?.() })
  process.on('uncaughtException', error => { console.error('invariant gate crashed:', error); terminate('SIGTERM', 1) })
  process.on('unhandledRejection', error => { console.error('invariant gate crashed:', error); terminate('SIGTERM', 1) })
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

/** True when a process with this pid exists (or exists under another user). */
function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * This gate edits the working tree in place, so two concurrent runs corrupt each
 * other: run A restores what run B mutated, and a source file is left holding a
 * mutation. Observed once on this branch during a parallel fix round. An
 * exclusive lock file makes the second run wait rather than interleave — and a
 * lock whose holder is gone is stale, not a reason to wait half an hour.
 */
function acquireLock(): () => void {
  const deadline = Date.now() + 30 * 60_000
  for (;;) {
    try {
      writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}\n`, { flag: 'wx' })
      return () => {
        try {
          if (readFileSync(lockPath, 'utf8').startsWith(`${process.pid}\n`)) unlinkSync(lockPath)
        } catch { /* already gone */ }
      }
    } catch {
      let holder: number | undefined
      try { holder = Number(readFileSync(lockPath, 'utf8').split('\n')[0]) } catch { /* raced away */ }
      if (holder !== undefined && !processIsAlive(holder)) {
        console.log(`invariant gate: taking over ${lockPath} from dead pid ${holder}`)
        try { unlinkSync(lockPath) } catch { /* raced away */ }
        continue
      }
      if (Date.now() > deadline) throw new Error(`another invariants:verify run holds ${lockPath}; refusing to run concurrently`)
      sleep(2_000)
    }
  }
}

/* ------------------------------------------------------------------ *
 * Evidence runs
 * ------------------------------------------------------------------ */

interface EvidenceRun { status: number; output: string }

/** Vitest, in this repository's root, with `args`; the exit code is the caller's to read. */
function spawnEvidence(mutation: InvariantMutation, environment: NodeJS.ProcessEnv, args: readonly string[], postgres: boolean): EvidenceRun {
  try {
    const result = execFileSync('npx', [...args], {
      cwd: root,
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: evidenceTimeoutMs,
      killSignal: 'SIGTERM',
      // The PostgreSQL evidence files are excluded from the last three isolated
      // manifests unless the run says it is sweeping everything; without this the
      // postgres config collects nothing and the run fails to load.
      env: { ...environment, INVARIANT_MUTATION: mutation.id, ...(postgres ? { MERCHANT_ISOLATED_POSTGRES_ALL: 'true' } : {}) },
      maxBuffer: 32 * 1024 * 1024,
    })
    return { status: 0, output: result }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string; signal?: string; killed?: boolean; code?: string }
    if (failure.killed || failure.code === 'ETIMEDOUT') {
      return {
        status: -1,
        output: `evidence process timed out after ${evidenceTimeoutMs}ms (killed by ${failure.signal ?? 'SIGTERM'})\n${failure.stdout ?? ''}\n${failure.stderr ?? ''}`,
      }
    }
    throw error
  }
}

/** The evidence test as the tree currently stands, under the configuration its row runs it with. */
function runEvidence(mutation: InvariantMutation, environment: NodeJS.ProcessEnv): EvidenceRun {
  const postgres = mutation.evidence.endsWith('.postgres.test.ts')
  const args = ['vitest', 'run', mutation.evidence, '--no-file-parallelism', ...(postgres ? ['--config', 'vitest.postgres.config.ts', '--reporter=default'] : [])]
  return spawnEvidence(mutation, environment, args, postgres)
}

/**
 * The observation run: the same evidence file, under a configuration that loads
 * whether or not the row's binding is exported.
 *
 * `vitest.postgres.config.ts` refuses to load without the binding, and a module
 * that never loads reports nothing about itself — not even that it is
 * skippable. Observing these rows through that config therefore produced the
 * same non-zero exit every single time, which is a verdict that cannot tell
 * "this machine has no database" apart from "this evidence file does not
 * compile"; the tolerance for the first was handed to the second. The fast
 * suite's own configuration collects the same file — the `.postgres.test.ts`
 * suffix is only in its exclusion list, which `--exclude` replaces for this one
 * file — and then the evidence's own `it.skip` gate is free to report itself,
 * which is the fact the declaration is actually about.
 *
 * `--reporter=default` also displaces the fast suite's pending-assertion
 * reporter, whose whole job is to fail a run for an undeclared pending
 * assertion. That failure would be read here as a broken evidence file, and it
 * is exactly what this run is trying to observe.
 */
function runEvidenceWithoutBinding(mutation: InvariantMutation, environment: NodeJS.ProcessEnv): EvidenceRun {
  const postgres = mutation.evidence.endsWith('.postgres.test.ts')
  const args = ['vitest', 'run', mutation.evidence, '--no-file-parallelism', '--reporter=default', ...(postgres ? ['--exclude', 'node_modules/**'] : [])]
  return spawnEvidence(mutation, environment, args, postgres)
}

function tryRunEvidence(mutation: InvariantMutation, environment: NodeJS.ProcessEnv, options: { withoutBinding?: boolean } = {}): EvidenceRun {
  try {
    return options.withoutBinding ? runEvidenceWithoutBinding(mutation, environment) : runEvidence(mutation, environment)
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string; signal?: string }
    if (failure.signal) return { status: -1, output: `killed by ${failure.signal}\n${failure.stdout ?? ''}\n${failure.stderr ?? ''}` }
    return { status: failure.status ?? -1, output: `${failure.stdout ?? ''}\n${failure.stderr ?? ''}` }
  }
}

/** Signatures of a run that never reached the assertion it was supposed to break. */
const UNATTRIBUTABLE = [
  { pattern: /Test timed out in \d/u, why: 'the evidence hit its wall-clock timeout, which says nothing about the guard' },
  { pattern: /Cannot find module|Failed to load url|Transform failed|No test files found/iu, why: 'the run never reached an assertion' },
  { pattern: /killed by SIG(?:TERM|KILL|SEGV|ABRT)/u, why: 'the test process was killed' },
  { pattern: /\(0 test\)|No test files|passWithNoTests/iu, why: 'no test ran at all' },
]

/** The part of a failed run an author needs in order to register `evidenceFailsWith`. */
function failureExcerpt(output: string): string {
  const lines = output.split('\n')
  const start = lines.findIndex(line => /Failed Tests|FAIL\b/u.test(line))
  const slice = lines.slice(start < 0 ? 0 : start, (start < 0 ? 0 : start) + 25)
  return slice.map(line => `      | ${line.trim()}`).join('\n')
}

/**
 * Whether the failure is the one the row predicted, rather than a timeout, a
 * crash or an unrelated assertion that happened to be red at the same time.
 *
 * The row's declared signature is authoritative: it names the exact assertion
 * (or, where the regression *is* a hang, the timeout) that proves the guard was
 * load-bearing. The generic signatures below only supply the reason when that
 * signature is absent — a non-zero exit on its own is never a proof.
 */
function attribution(mutation: InvariantMutation, run: EvidenceRun, explainFailure: boolean): { ok: boolean; detail: string } {
  if (mutation.evidenceFailsWith && run.output.includes(mutation.evidenceFailsWith)) {
    return { ok: true, detail: 'evidence failed on the expected assertion' }
  }
  const signature = UNATTRIBUTABLE.find(entry => entry.pattern.test(run.output))
  if (signature) return { ok: false, detail: `${signature.why} (expected "${mutation.evidenceFailsWith ?? '<none declared>'}")${explainFailure ? `\n${failureExcerpt(run.output)}` : ''}` }
  if (!mutation.evidenceFailsWith) {
    return { ok: false, detail: 'the row declares no evidenceFailsWith, so this run cannot be attributed to a named assertion' }
  }
  return {
    ok: false,
    detail: `the evidence failed, but not with the registered assertion (expected "${mutation.evidenceFailsWith}")${explainFailure ? `\n${failureExcerpt(run.output)}` : '; re-run with --explain for the observed output'}`,
  }
}

/* ------------------------------------------------------------------ *
 * Owned PostgreSQL binding
 * ------------------------------------------------------------------ */

interface OwnedPostgres { url: string; runId: string; dispose: () => Promise<void> }

/**
 * Creates the same owned fixture `npm run test:postgres:isolated` uses, so the
 * rows whose evidence needs real PostgreSQL are reproducible from a bare
 * checkout instead of silently scoring `NOT RUN` (9 of 19 did, while the
 * headline still read "19/19").
 */
async function createOwnedPostgres(): Promise<OwnedPostgres> {
  const { mkdtemp, mkdir } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { createIsolatedOpsFixture } = await import(pathToFileURL(resolve(root, 'tests/isolated-ops-fixture.ts')).href) as typeof import('../tests/isolated-ops-fixture.js')
  const parent = join(root, 'artifacts/isolated-postgres')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const fixture = await createIsolatedOpsFixture({ evidenceDir: await mkdtemp(join(parent, 'run-mutation-gate-')) })
  const pool = new Pool({ connectionString: fixture.adminDatabaseUrl, max: 1, connectionTimeoutMillis: 1_000 })
  try {
    // The fixture-only role passwords the acceptance files expect; this
    // connection can only be the fixture this process just created.
    await pool.query("ALTER ROLE merchant_app PASSWORD 'merchant_app_local_only'")
    await pool.query("ALTER ROLE merchant_ops PASSWORD 'merchant_ops_local_only'")
  } finally { await pool.end() }
  return {
    url: fixture.adminDatabaseUrl,
    runId: fixture.runId,
    dispose: async () => { await fixture.dispose() },
  }
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

interface RowResult {
  id: string
  verdict: 'OK' | 'FAIL' | 'NOT RUN'
  detail: string
  /**
   * The row did not run because its declared binding and the owned fixture
   * that supplies it were both unavailable — not because anything was found
   * wrong. Only this kind of NOT RUN may be tolerated by the `check`
   * entrypoint (`--tolerate-missing-bindings`); a NOT RUN caused by evidence
   * that is already red stays fatal, because that is a finding.
   *
   * Set only once the row has been *observed* to be blocked: its evidence
   * declares the dependency and, run without the binding under a configuration
   * that loads, reports every collected assertion as skipped. A row that merely
   * declares a binding it does not use never reaches this verdict — it runs —
   * and neither does a row whose evidence file cannot be collected at all
   * without the binding: that is a FAIL, in both modes.
   */
  preconditionUnavailable?: boolean
}

/** A row that throws (a bad anchor, an unreadable file) fails that row, not the run. */
function attempt(mutation: InvariantMutation, environment: NodeJS.ProcessEnv): RowResult {
  try {
    return check(mutation, environment)
  } catch (error) {
    return { id: mutation.id, verdict: 'FAIL', detail: `the row could not be evaluated: ${error instanceof Error ? error.message : error}` }
  } finally {
    restoreAll()
  }
}

/**
 * What the evidence does when the row's declared binding is absent.
 *
 * NOT RUN is granted on observation only, and the observation has to be able to
 * *see* the evidence file to observe anything. The three outcomes, and why only
 * the first is tolerable:
 *
 *   - `blocked` — every collected assertion reported skipped. The file stood
 *     down because the binding is missing; that is the fact `requires` claims,
 *     and it says nothing about whether the guard works. NOT RUN.
 *   - `broken` — the file was collected and either its run failed or it
 *     collected nothing to skip. Whatever is wrong with it, it is wrong on a
 *     machine that has the binding too: a syntax error, a missing import, a
 *     top-level throw, an emptied file. That is a finding about the evidence,
 *     not a missing database, and it stays fatal in both modes.
 *   - `ran` — something ran green with nothing skipped, so the declaration
 *     decided nothing about this run. The row is executed like any other.
 */
type Observation = { kind: 'blocked' | 'broken'; detail: string } | { kind: 'ran' }

/** A run that reached no assertion at all, whatever the exit code said. */
const COLLECTED_NOTHING = /\(0 test\)|No test files|no tests/iu

function observeWithoutBinding(mutation: InvariantMutation, environment: NodeJS.ProcessEnv): Observation {
  const probe = tryRunEvidence(mutation, environment, { withoutBinding: true })
  // The launcher's environment makes vitest colour this line even through a
  // pipe, and the observable is anchored on `Tests`.
  const skipped = stripAnsi(probe.output).match(EVERY_ASSERTION_SKIPPED)
  if (skipped) {
    return {
      kind: 'blocked',
      detail: `${mutation.requires} is unset and no owned fixture was created; run without it, ${mutation.evidence} reports every assertion as skipped ("${skipped[0].trim()}"), so the guard did not run (observed, not declared)`,
    }
  }
  if (probe.status !== 0 || COLLECTED_NOTHING.test(probe.output)) {
    return {
      kind: 'broken',
      detail: `the evidence is unusable whether or not ${mutation.requires} is set: run without it, ${mutation.evidence} did not report a single skipped assertion — ${probe.status === 0 ? 'it collected no assertion at all' : `its run failed (exit ${probe.status})`}. That is a defect in the evidence file, not a missing database, so the row is not tolerated${explain ? `\n${failureExcerpt(probe.output)}` : '; re-run with --explain for the observed output'}`,
    }
  }
  return { kind: 'ran' }
}

/**
 * How a row is scored when its declared binding is not in the environment.
 *
 * The declaration is a claim about the evidence file, so it is checked against
 * that file rather than trusted:
 *
 *   1. if the evidence does not gate itself on the binding (`unsupportedRequires`),
 *      the row has no excuse and runs exactly as it would on a machine that has
 *      the binding — this is what closes "declare a binding you never read and
 *      your broken guard is reported NOT RUN instead of FAIL";
 *   2. if it does gate itself on the binding, the evidence is *run* without the
 *      binding under a configuration that loads regardless, and the block has
 *      to be visible in that run: every collected assertion skipped. A binding
 *      read in a comment, in an unused constant, or in a guard that is not on
 *      the assertions leaves the run green and skipped-free, and the row runs
 *      too — while a run that collects nothing, or that fails, is a defect in
 *      the evidence file and fails the row outright, tolerance or not.
 *
 * Only then is the row NOT RUN — and NOT RUN is not a pass: it is counted
 * separately, named in the headline, and excluded from the certified total.
 */
function rowResult(mutation: InvariantMutation, environment: NodeJS.ProcessEnv): RowResult {
  const binding = mutation.requires?.trim()
  if (!binding || environment[binding]?.trim()) return attempt(mutation, environment)

  const evidencePath = resolve(root, mutation.evidence)
  // A missing evidence file is `check`'s finding, not a reason to skip the row.
  if (!existsSync(evidencePath)) return attempt(mutation, environment)

  const unsupported = unsupportedRequires(mutation, readFileSync(evidencePath, 'utf8'))
  if (unsupported) {
    const result = attempt(mutation, environment)
    if (result.verdict === 'OK') return result
    return { ...result, detail: `${result.detail}\n  the row ${unsupported}` }
  }

  const observed = observeWithoutBinding(mutation, environment)
  if (observed.kind === 'broken') return { id: mutation.id, verdict: 'FAIL', detail: observed.detail }
  if (observed.kind === 'ran') {
    const result = attempt(mutation, environment)
    if (result.verdict === 'OK') return result
    return { ...result, detail: `${result.detail}\n  the row declares requires: ${binding}, but its evidence ran green with nothing skipped when the binding was absent` }
  }
  return { id: mutation.id, verdict: 'NOT RUN', preconditionUnavailable: true, detail: observed.detail }
}

function check(mutation: InvariantMutation, environment: NodeJS.ProcessEnv): RowResult {
  const path = resolve(root, mutation.file)
  if (!existsSync(path)) return { id: mutation.id, verdict: 'FAIL', detail: `mutation file missing: ${mutation.file}` }
  if (!existsSync(resolve(root, mutation.evidence))) return { id: mutation.id, verdict: 'FAIL', detail: `evidence test missing: ${mutation.evidence}` }

  // Baseline first. Without it, an evidence test that is already red for an
  // unrelated reason would be scored as "went red as required" and the gate
  // would certify a guard that has no teeth.
  const runStage = (stage: string): EvidenceRun => {
    console.log(`\n  [${mutation.id}] ${stage} (timeout ${evidenceTimeoutMs}ms)`)
    return tryRunEvidence(mutation, environment)
  }

  const baseline = runStage('baseline')
  if (baseline.status !== 0) {
    const attributed = attribution(mutation, baseline, explain)
    return { id: mutation.id, verdict: 'NOT RUN', detail: `NOT ATTRIBUTABLE — the evidence was already failing before the mutation (${attributed.ok ? 'reported a named assertion' : attributed.detail})` }
  }

  // 1. The guard's own removal must turn the evidence red, on a named assertion.
  try {
    const applied = applyReplacements(mutation.file, [{ find: mutation.find, replace: mutation.replace }])
    let mutated: EvidenceRun
    try {
      mutated = runStage('guard mutation')
    } finally {
      applied.restore()
    }
    if (mutated.status === 0) return { id: mutation.id, verdict: 'FAIL', detail: `evidence stayed GREEN under mutation: ${mutation.evidence}` }
    const attributed = attribution(mutation, mutated, explain)
    if (!attributed.ok) return { id: mutation.id, verdict: 'FAIL', detail: `NOT ATTRIBUTABLE — ${attributed.detail}` }

    // 2. The same evidence must go green again from the restored tree, so the
    // red really was caused by the mutation and not by state it left behind
    // (the worker evidence asserts on wall-clock behaviour and flakes under
    // load; a flake here would otherwise be read as a guard).
    const restored = runStage('restored tree')
    if (restored.status !== 0) {
      const restoredAttribution = attribution(mutation, restored, explain)
      return { id: mutation.id, verdict: 'FAIL', detail: `the evidence did not return to green after the file was restored — the red was not caused by the mutation alone (${restoredAttribution.detail})` }
    }

    // 3. The opposite direction: the same guard refusing everything it is
    // supposed to allow must be caught by the same evidence, or the evidence
    // only ever proved one half of the sentence.
    const over = mutation.overRejection
    if (!over) return { id: mutation.id, verdict: 'FAIL', detail: 'the row declares no overRejection mutation, so nothing shows the evidence lets a legitimate write through' }
    const overApplied = applyReplacements(over.file ?? mutation.file, [{ find: over.find, replace: over.replace }])
    let overRun: EvidenceRun
    try {
      overRun = runStage('over-rejection mutation')
    } finally {
      overApplied.restore()
    }
    if (overRun.status === 0) {
      return { id: mutation.id, verdict: 'FAIL', detail: `ONE-SIDED EVIDENCE — the evidence passes when the guard is over-rejected (${over.why})` }
    }
    const overAttribution = attribution(mutation, overRun, explain)
    if (!overAttribution.ok) return { id: mutation.id, verdict: 'FAIL', detail: `NOT ATTRIBUTABLE — the over-rejection run failed for the wrong reason: ${overAttribution.detail}` }

    // 4. The rule the evidence reads its definition from is load-bearing: with
    // the rule broken the evidence must stop detecting the code mutation.
    const rule = mutation.ruleMutation
    if (rule) {
      const codeAndRule = applyReplacements(mutation.file, [{ find: mutation.find, replace: mutation.replace }])
      let ruleApplied: { restore: () => void } | undefined
      let ruleRun: EvidenceRun
      try {
        ruleApplied = applyReplacements(rule.file, [{ find: rule.find, replace: rule.replace }])
        ruleRun = runStage('code + rule mutation')
      } finally {
        ruleApplied?.restore()
        codeAndRule.restore()
      }
      if (ruleRun.status !== 0) {
        return { id: mutation.id, verdict: 'FAIL', detail: `SELF-MUTATION SURVIVED — the evidence still failed with the rule broken and the code mutation in place, so it does not read the rule it claims to stand behind (${rule.why})` }
      }
    }

    return { id: mutation.id, verdict: 'OK', detail: rule ? 'both directions red; the rule is load-bearing' : 'both directions red' }
  } finally {
    restoreAll()
  }
}

async function runVerified(filter: string[]): Promise<void> {
  const all = await loadMutations()
  const selected = filter.length ? all.filter(mutation => filter.some(prefix => mutation.id.startsWith(prefix))) : all
  if (!all.length) {
    console.log('invariant gate: registry is empty — nothing is pinned yet')
    return
  }
  if (!selected.length) {
    console.error(`invariant gate: no invariant matches ${filter.join(', ')}`)
    process.exitCode = 1
    return
  }

  // Uniqueness before mutation: a mutation says one implementation is
  // load-bearing, which is worthless if a second implementation exists three
  // files away. This is the check the previous version certified without doing.
  const audit: UniquenessAudit = auditUniqueness(root, selected)
  let uniquenessFailed = 0
  for (const finding of audit.violations) {
    uniquenessFailed += 1
    console.log(`- ${finding.id} — SECOND IMPLEMENTATION / STALE ENUMERATION`)
    console.log(`  invariant row: ${selected.find(mutation => mutation.id === finding.id)?.invariant ?? ''}`)
    console.log(finding.summary)
  }
  for (const finding of audit.vacuous) {
    uniquenessFailed += 1
    console.log(`- ${finding.id} — UNIQUENESS NOT AUDITED`)
    console.log(finding.summary)
  }
  console.log(`uniqueness audit: ${audit.certified.length}/${selected.length} rows certified as having one implementation\n`)

  const requiredBindings = [...new Set(selected.flatMap(mutation => mutation.requires ? [mutation.requires] : []))]
  const missingBindings = requiredBindings.filter(name => !process.env[name]?.trim())
  let owned: OwnedPostgres | undefined
  const environment: NodeJS.ProcessEnv = { ...process.env }
  if (missingBindings.length && !skipPostgres) {
    console.log(`invariant gate: creating an owned PostgreSQL fixture for ${missingBindings.join(', ')} …`)
    try {
      owned = await createOwnedPostgres()
      for (const name of missingBindings) environment[name] = owned.url
      environment.MERCHANT_ISOLATED_POSTGRES_RUN_ID = owned.runId
      console.log('invariant gate: fixture ready\n')
    } catch (error) {
      console.log(`invariant gate: fixture failed (${error instanceof Error ? error.message : error}) — those rows report NOT RUN\n`)
    }
  } else {
    for (const name of missingBindings) environment[name] = process.env[name] ?? ''
  }

  let ok = 0
  let failed = 0
  let notRun = 0
  let preconditionUnavailable = 0
  try {
    for (const mutation of selected) {
      process.stdout.write(`- ${mutation.id} … `)
      const result: RowResult = rowResult(mutation, environment)
      if (result.preconditionUnavailable) preconditionUnavailable += 1
      if (result.verdict === 'OK') { ok += 1; console.log('OK') } else {
        if (result.verdict === 'FAIL') failed += 1
        else notRun += 1
        console.log(`${result.verdict} — ${result.detail}`)
        console.log(`  invariant: ${mutation.invariant}`)
        console.log(`  chokepoint: ${mutation.chokepoint} (${mutation.chokepointSymbol})`)
        console.log(`  evidence: ${mutation.evidence}`)
      }
    }
  } finally {
    restoreAll()
    if (owned) {
      try { await owned.dispose() } catch (error) { console.error(`invariant gate: fixture disposal failed: ${error instanceof Error ? error.message : error}`); process.exitCode = 1 }
    }
  }

  // The headline states every precondition. "19/19" used to mean "19 mutations
  // were applied", of which the nine needing PostgreSQL had not run at all.
  console.log(`\ninvariant gate: ${ok}/${selected.length} mutations turned their evidence red on a named assertion${notRun ? `; ${notRun} not run (${requiredBindings.join(', ') || 'binding unavailable'})` : ''}${failed ? `; ${failed} FAILED` : ''}`)
  console.log(`invariant gate: uniqueness ${audit.certified.length}/${selected.length} certified${uniquenessFailed ? `, ${uniquenessFailed} row(s) with a second implementation or an unaudited rule` : ''}`)

  // An unavailable precondition is not a pass and is not a failure of the
  // branch. `check` runs with `--tolerate-missing-bindings` because a developer
  // machine may have no Docker daemon, and a gate that can never complete
  // locally is a gate everybody learns to bypass. What tolerance must never do
  // is let those rows read as green: they are counted separately, named in the
  // headline, and the run explicitly refuses to certify them.
  const unattributedNotRun = notRun - preconditionUnavailable
  const tolerated = tolerateMissingBindings && preconditionUnavailable > 0
  if (tolerated) {
    console.log(`\ninvariant gate: NOT RUN — ${preconditionUnavailable} row(s) had no ${requiredBindings.join(', ') || 'required'} binding, no owned fixture could be created, and their evidence was observed to report every collected assertion as skipped rather than run.`)
    console.log('invariant gate: those guards are NOT certified by this run. Run `npm run invariants:verify` on a machine where the isolated PostgreSQL fixture can start.')
  }
  const blocking = failed > 0 || unattributedNotRun > 0 || audit.certified.length !== selected.length
  const incomplete = notRun > 0 || audit.certified.length !== selected.length
  console.log(`invariant gate: ${blocking ? 'NO-GO' : incomplete ? (tolerated ? 'INCOMPLETE — precondition unavailable, nothing certified by this run' : 'INCOMPLETE — this run does not certify the branch') : 'GO — every registered row is a guard and is unique'}`)
  if (blocking || (incomplete && !tolerated)) process.exitCode = 1
}

async function main(): Promise<void> {
  const filter = process.argv.slice(2).filter(argument => !argument.startsWith('-'))
  const release = acquireLock()
  releasing = release
  installTerminationHandlers()
  try {
    await runVerified(filter)
  } finally {
    restoreAll()
    release()
    releasing = undefined
  }
}

main().catch(error => {
  restoreAll()
  releasing?.()
  console.error('invariant gate failed to run:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
