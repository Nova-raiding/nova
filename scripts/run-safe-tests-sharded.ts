import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { buildSafeTestEnvironment, runSafeTests } from './run-safe-tests.js'

// The suite now contains enough browser/API-heavy files that four sequential
// buckets can exceed runSafeTests' five-minute per-process safety limit.
const DEFAULT_SHARD_COUNT = 8
const MAX_SHARD_COUNT = 16
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const execFileAsync = promisify(execFile)

export async function listSafeTestFiles(source: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const environment = buildSafeTestEnvironment(source, join(tmpdir(), 'merchant-safe-test-discovery'))
  const { stdout } = await execFileAsync(process.execPath, [join(projectRoot, 'node_modules/vitest/vitest.mjs'), 'list', '--filesOnly'], {
    cwd: projectRoot,
    env: environment,
    maxBuffer: 16 * 1024 * 1024,
  })
  const files = stdout.split(/\r?\n/u).map(file => file.trim()).filter(Boolean)
  if (files.length === 0) throw new Error('Safe test discovery returned no files')
  return files
}

export function safeTestShardCount(source: NodeJS.ProcessEnv): number {
  const raw = source.SAFE_TEST_SHARD_COUNT?.trim()
  if (!raw) return DEFAULT_SHARD_COUNT
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > MAX_SHARD_COUNT) {
    throw new Error(`SAFE_TEST_SHARD_COUNT must be an integer between 1 and ${MAX_SHARD_COUNT}`)
  }
  return value
}

export function safeTestShardSelection(source: NodeJS.ProcessEnv, shardCount: number): number[] {
  const raw = source.SAFE_TEST_SHARDS?.trim()
  if (!raw) return Array.from({ length: shardCount }, (_, index) => index + 1)
  const selected = raw.split(',').map(value => value.trim())
  if (selected.some(value => !/^\d+$/u.test(value))) {
    throw new Error(`SAFE_TEST_SHARDS must be comma-separated shard numbers between 1 and ${shardCount}`)
  }
  const numbers = selected.map(Number)
  if (numbers.length === 0 || numbers.some(value => value < 1 || value > shardCount) || new Set(numbers).size !== numbers.length) {
    throw new Error(`SAFE_TEST_SHARDS must contain unique shard numbers between 1 and ${shardCount}`)
  }
  return numbers.sort((left, right) => left - right)
}

function hasExplicitTestFileSelection(args: readonly string[]): boolean {
  return args.some(argument => /\.(?:test|spec)\.(?:[cm]?[jt]sx?)(?::\d+(?:-\d+)?)?$/u.test(argument))
}

export async function runSafeTestShards(
  args: readonly string[],
  source: NodeJS.ProcessEnv = process.env,
  runShard: typeof runSafeTests = runSafeTests,
  write: (message: string) => void = message => console.error(message),
  listFiles: (source: NodeJS.ProcessEnv) => Promise<string[]> = listSafeTestFiles,
): Promise<number> {
  // Explicit test-file filters stay a single isolated invocation. Appending
  // them to every repository shard accidentally runs the whole suite again
  // when developers expect a focused regression test.
  if (hasExplicitTestFileSelection(args)) {
    write('[safe-tests] explicit test-file selection; running one isolated invocation')
    const exitCode = await runShard([...args], source)
    write(`[safe-tests] explicit test-file selection ${exitCode === 0 ? 'passed' : `failed (exit ${exitCode})`}`)
    return exitCode
  }

  const shardCount = safeTestShardCount(source)
  const selectedShards = safeTestShardSelection(source, shardCount)
  const files = await listFiles(source)
  const shards = Array.from({ length: shardCount }, () => [] as string[])
  files.forEach((file, index) => shards[index % shardCount]!.push(file))
  const failures: Array<{ shard: number; exitCode: number }> = []

  for (const shard of selectedShards) {
    const startedAt = Date.now()
    write(`[safe-tests] shard ${shard}/${shardCount} started`)
    let exitCode: number
    try {
      exitCode = await runShard([...shards[shard - 1]!, ...args], source)
    } catch (error) {
      write(`[safe-tests] shard ${shard}/${shardCount} launcher error: ${error instanceof Error ? error.message : String(error)}`)
      exitCode = 1
    }
    const elapsedSeconds = ((Date.now() - startedAt) / 1_000).toFixed(1)
    write(`[safe-tests] shard ${shard}/${shardCount} ${exitCode === 0 ? 'passed' : `failed (exit ${exitCode})`} in ${elapsedSeconds}s`)
    if (exitCode !== 0) failures.push({ shard, exitCode })
  }

  if (failures.length > 0) {
    write(`[safe-tests] failed shards: ${failures.map(({ shard, exitCode }) => `${shard}/${shardCount} (exit ${exitCode})`).join(', ')}`)
    return failures[0]!.exitCode
  }
  write(selectedShards.length === shardCount
    ? `[safe-tests] all ${shardCount} shards passed`
    : `[safe-tests] selected shards passed: ${selectedShards.join(',')}/${shardCount}`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runSafeTestShards(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Safe sharded test launcher failed')
    process.exitCode = 1
  }
}
