import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { buildSafeTestEnvironment, runSafeTests } from './run-safe-tests.js'

const DEFAULT_SHARD_COUNT = 4
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

export async function runSafeTestShards(
  args: readonly string[],
  source: NodeJS.ProcessEnv = process.env,
  runShard: typeof runSafeTests = runSafeTests,
  write: (message: string) => void = message => console.error(message),
  listFiles: (source: NodeJS.ProcessEnv) => Promise<string[]> = listSafeTestFiles,
): Promise<number> {
  const shardCount = safeTestShardCount(source)
  const files = await listFiles(source)
  const shards = Array.from({ length: shardCount }, () => [] as string[])
  files.forEach((file, index) => shards[index % shardCount]!.push(file))
  const failures: Array<{ shard: number; exitCode: number }> = []

  for (let shard = 1; shard <= shardCount; shard += 1) {
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
  write(`[safe-tests] all ${shardCount} shards passed`)
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
