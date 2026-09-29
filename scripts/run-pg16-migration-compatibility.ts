import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PG16_MIGRATION_TEST_FILES, pg16MigrationTestEnvironment, selectPg16MigrationTests, validatePg16MigrationReport } from './pg16-migration-test-entrypoint.js'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let activeChild: ReturnType<typeof spawn> | undefined

export async function runPg16MigrationCompatibility(args: readonly string[], source: NodeJS.ProcessEnv = process.env): Promise<number> {
  const selectedFiles = selectPg16MigrationTests(args)
  const reportDirectory = await mkdtemp(join(tmpdir(), 'merchant-pg16-migration-report-'))
  const reportPath = join(reportDirectory, 'vitest.json')
  const environment = pg16MigrationTestEnvironment(source, reportPath)
  let childExitCode = 1
  let errors: string[] = []
  try {
    childExitCode = await new Promise<number>((resolveExit, reject) => {
      activeChild = spawn(process.execPath, [
        join(projectRoot, 'node_modules/vitest/vitest.mjs'), 'run', ...selectedFiles,
        '--config', join(projectRoot, 'vitest.pg16-migration.config.ts'), '--no-file-parallelism',
      ], { cwd: projectRoot, env: environment, stdio: 'inherit' })
      activeChild.once('error', () => { activeChild = undefined; reject(new Error('PG16_ISOLATED_TEST_PROCESS_FAILED')) })
      activeChild.once('close', code => { activeChild = undefined; resolveExit(code ?? 1) })
    })
    if (childExitCode !== 0) errors.push('PG16_ISOLATED_TEST_PROCESS_NONZERO')
    try {
      errors.push(...validatePg16MigrationReport(JSON.parse(await readFile(reportPath, 'utf8')) as unknown))
    } catch {
      errors.push('PG16_REPORT_MISSING_OR_INVALID')
    }
  } catch {
    errors.push('PG16_ISOLATED_TEST_RUN_FAILED')
  } finally {
    activeChild = undefined
    try { await rm(reportDirectory, { recursive: true }) } catch { errors.push('PG16_REPORT_CLEANUP_FAILED') }
  }
  const exitCode = errors.length === 0 ? 0 : 1
  console.log(`PostgreSQL 16 migration acceptance ${exitCode === 0 ? 'passed' : 'failed'}; selected files: ${selectedFiles.length}`)
  if (errors.length) console.error(`PostgreSQL 16 migration acceptance errors: ${[...new Set(errors)].join(', ')}`)
  return exitCode
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const interrupt = () => activeChild?.kill('SIGINT')
  const terminate = () => activeChild?.kill('SIGTERM')
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', terminate)
  try {
    process.exitCode = await runPg16MigrationCompatibility(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error && error.message.startsWith('This entrypoint accepts only')
      ? `PostgreSQL 16 migration entrypoint failed: ${error.message}`
      : 'PostgreSQL 16 migration entrypoint failed; no external runtime configuration was used.')
    process.exitCode = 1
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
  }
}
