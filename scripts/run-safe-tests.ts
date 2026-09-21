import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NON_HERMETIC_TEST_FILES } from '../tests/test-suite-isolation.js'

const SYSTEM_ENVIRONMENT_KEYS = [
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_COLLATE', 'TZ',
  'CI', 'GITHUB_ACTIONS', 'SAFE_TEST_TIMEOUT_MS', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'USER', 'LOGNAME',
  'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'NUMBER_OF_PROCESSORS',
] as const

/** Explicit PG/Redis acceptance must use its own launcher, not this environment. */
export function buildSafeTestEnvironment(source: NodeJS.ProcessEnv, storageRoot: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const key of SYSTEM_ENVIRONMENT_KEYS) {
    if (source[key] !== undefined) environment[key] = source[key]
  }
  environment.NODE_ENV = 'test'
  environment.ASSET_STORAGE_ROOT = storageRoot
  return environment
}

const ISOLATION_OVERRIDES = new Set([
  '--config', '-c', '--root', '-r', '--dir', '--project', '--workspace', '--include', '--exclude',
  '--passWithNoTests', '--watch', '-w', '--ui', '--standalone', '--api', '--browser',
  '--setupFiles', '--globalSetup', '--execArgv',
])

/**
 * Vitest replaces `test.reporters` wholesale when the CLI supplies `--reporter`
 * (see the `cliReporters` branch of its config resolution), so a caller passing
 * an ordinary output preference such as `--reporter=verbose` would silently
 * unregister the pending-assertion gate and let a wholly skipped file report a
 * green suite. The gate is part of the default configuration, not of the
 * caller's output choices, so every CLI reporter list is extended with it
 * instead of being trusted to include it. `tests/test-summary.ts` is the reason
 * this is an append rather than a rejection: it needs `--reporter=json` for its
 * machine-readable evidence.
 */
export const PENDING_GATE_REPORTER = './scripts/pending-assertion-gate.ts'
const REPORTER_OPTIONS = new Set(['--reporter', '--reporters'])

export function buildSafeVitestArgs(input: readonly string[]): string[] {
  const command = input[0] === 'watch' ? 'watch' : 'run'
  const args = input[0] === 'run' || input[0] === 'watch' ? input.slice(1) : [...input]
  for (const argument of args) {
    const option = argument.split('=', 1)[0]!
    if (ISOLATION_OVERRIDES.has(option)
      || [...ISOLATION_OVERRIDES].some(name => name.startsWith('--') && option.startsWith(`${name}.`))
      || /^-[crw].+/u.test(option) && !option.startsWith('--')
      || ['watch', 'dev', 'bench', 'benchmark', 'related', 'list', 'init', 'typecheck'].includes(argument)) {
      throw new Error('This option is not supported by the safe test entrypoint; use the dedicated integration entrypoint for another runtime or configuration.')
    }
    const selection = posix.normalize(argument.replaceAll('\\', '/').replace(/:\d+(?:-\d+)?$/u, ''))
    const blocked = NON_HERMETIC_TEST_FILES.find(file => selection === file
      || selection.endsWith(`/${file}`)
      || selection === basename(file)
      || selection === basename(file).replace(/\.test\.ts$/u, ''))
    if (blocked) throw new Error(`${blocked} requires a dedicated integration entrypoint with an explicitly isolated runtime; it is excluded from the safe default suite.`)
  }
  // A CLI reporter list replaces the configuration's reporters instead of
  // extending them, so the gate has to be re-added here to survive it.
  const withGate = args.some(argument => REPORTER_OPTIONS.has(argument.split('=', 1)[0]!))
    ? [...args, `--reporter=${PENDING_GATE_REPORTER}`]
    : args
  // A typo, excluded filter, or empty project must fail rather than claim a
  // passing test run. The default config owns the audited exclusion manifest.
  return [command, ...withGate, '--passWithNoTests=false']
}

export interface SafeTestRuntime {
  createStorageRoot(): Promise<string>
  runVitest(args: string[], environment: NodeJS.ProcessEnv): Promise<number>
  removeStorageRoot(path: string): Promise<void>
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const EXPLICIT_TEST_FILE = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/u

/**
 * Vitest exits successfully when one requested file exists even if another
 * explicit file argument is misspelled. Release scripts enumerate long test
 * lists, so that behaviour can silently shrink the gate while leaving it
 * green. Validate path-shaped test selections before allocating fixtures or
 * starting the child process; ordinary name-pattern filters remain supported.
 */
export function validateExplicitTestFiles(input: readonly string[], root = projectRoot): void {
  for (const argument of input) {
    if (argument.startsWith('-') || ['run', 'watch'].includes(argument)) continue
    const selection = argument.replace(/:\d+(?:-\d+)?$/u, '')
    if (!EXPLICIT_TEST_FILE.test(selection) || !/[\\/]/u.test(selection)) continue
    if (!existsSync(resolve(root, selection))) {
      throw new Error(`Explicit test file does not exist: ${argument}`)
    }
  }
}

const ownedStorageRoots = new Set<string>()
const defaultRuntime: SafeTestRuntime = {
  async createStorageRoot() {
    const storageRoot = await realpath(await mkdtemp(join(tmpdir(), 'merchant-safe-tests-')))
    ownedStorageRoots.add(storageRoot)
    return storageRoot
  },
  runVitest(args, environment) {
    return new Promise((resolveExit, reject) => {
      const child = spawn(process.execPath, [join(projectRoot, 'node_modules/vitest/vitest.mjs'), ...args], {
        cwd: projectRoot, env: environment, stdio: 'inherit', detached: true,
      })
      const signalGroup = (signal: NodeJS.Signals) => {
        if (child.pid) { try { process.kill(-child.pid, signal); return } catch { /* fall through */ } }
        child.kill(signal)
      }
      const interrupt = () => { signalGroup('SIGINT') }
      const terminate = () => { signalGroup('SIGTERM') }
      // The complete repository suite is intentionally serialized for
      // isolation. Shared CI runners routinely need more than five minutes,
      // while local invocations should keep the shorter hang guard.
      const ciValue = environment.CI?.trim().toLowerCase()
      const actionsValue = environment.GITHUB_ACTIONS?.trim().toLowerCase()
      const isCi = ciValue === 'true' || ciValue === '1' || actionsValue === 'true'
      const defaultTimeoutMs = isCi ? 900_000 : 300_000
      const requestedTimeoutMs = Number(environment.SAFE_TEST_TIMEOUT_MS ?? defaultTimeoutMs)
      const timeoutMs = Number.isFinite(requestedTimeoutMs)
        ? Math.max(10_000, requestedTimeoutMs)
        : defaultTimeoutMs
      const timeout = setTimeout(() => {
        console.error(`Safe test run exceeded ${timeoutMs}ms; terminating Vitest for diagnosability.`)
        signalGroup('SIGTERM')
        setTimeout(() => signalGroup('SIGKILL'), 2_000).unref()
      }, timeoutMs)
      const detach = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate) }
      process.once('SIGINT', interrupt)
      process.once('SIGTERM', terminate)
      child.once('error', error => { detach(); reject(error) })
      child.once('close', (code, signal) => {
        clearTimeout(timeout)
        detach()
        resolveExit(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1))
      })
    })
  },
  async removeStorageRoot(path) {
    // Only a path returned by this process's mkdtemp may be removed. Never
    // trust an inherited ASSET_STORAGE_ROOT or a caller-supplied directory.
    if (!ownedStorageRoots.has(path) || !basename(path).startsWith('merchant-safe-tests-')) {
      throw new Error('Refusing to clean a directory not created by the safe test launcher')
    }
    await rm(path, { recursive: true, force: true })
    ownedStorageRoots.delete(path)
  },
}

export async function runSafeTests(args: readonly string[], source: NodeJS.ProcessEnv = process.env, runtime: SafeTestRuntime = defaultRuntime): Promise<number> {
  const vitestArgs = buildSafeVitestArgs(args)
  validateExplicitTestFiles(args)
  const storageRoot = await runtime.createStorageRoot()
  try {
    return await runtime.runVitest(vitestArgs, buildSafeTestEnvironment(source, storageRoot))
  } finally {
    await runtime.removeStorageRoot(storageRoot)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runSafeTests(process.argv.slice(2)) } catch (error) {
    console.error(error instanceof Error ? error.message : 'Safe test launcher failed')
    process.exitCode = 1
  }
}
