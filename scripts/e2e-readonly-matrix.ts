import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

type Suite = {
  id: string
  area: 'plugin' | 'api-mcp' | 'merchant-ui' | 'ops-ui' | 'authorization' | 'payments' | 'model'
  command: string
  args: string[]
}

type Result = Suite & { status: 'passed' | 'failed'; exitCode: number | null; durationMs: number; output: string }

const suites: Suite[] = [
  { id: 'plugin-contract', area: 'plugin', command: 'npm', args: ['run', 'test:plugin-import-contract'] },
  { id: 'api-mcp-contracts', area: 'api-mcp', command: 'node', args: ['--import', 'tsx', 'scripts/run-safe-tests.ts', '--no-file-parallelism', 'tests/mcp-surface-contract.test.ts', 'tests/mcp-integration-mode-release-gate.test.ts', 'tests/openapi-contract.test.ts'] },
  { id: 'merchant-ui', area: 'merchant-ui', command: 'npm', args: ['run', 'test:merchant-studio-smoke'] },
  { id: 'ops-ui-readonly', area: 'ops-ui', command: 'npm', args: ['run', 'test:browser:ops:matrix'] },
  { id: 'authorization', area: 'authorization', command: 'npm', args: ['run', 'test:authorization-postgres'] },
  { id: 'payment-contracts', area: 'payments', command: 'npm', args: ['run', 'test:payment-callback-replay'] },
  { id: 'model-relay-contracts', area: 'model', command: 'node', args: ['--import', 'tsx', 'scripts/run-safe-tests.ts', '--no-file-parallelism', 'packages/ai/src/relay-usage.test.ts', 'packages/ai/src/relay-pricing.test.ts', 'packages/ai/src/video-generator.test.ts'] },
]

// Keep this list deliberately narrow: these are all isolated, contract, snapshot,
// or explicitly read-only browser checks. A new suite must be reviewed here rather
// than allowing arbitrary shell commands through CLI arguments.
const forbidden = /(?:deploy|publish|release|product-import|payment(?!-callback-replay)|create|update|delete|write|mutat)/iu

function parseArgs(argv: string[]) {
  const selected = argv.find(value => value.startsWith('--only='))?.slice('--only='.length).split(',').filter(Boolean)
  const skipBrowser = argv.includes('--skip-browser')
  const output = argv.find(value => value.startsWith('--output='))?.slice('--output='.length)
  return { selected, skipBrowser, output }
}

function runSuite(suite: Suite): Promise<Result> {
  const started = Date.now()
  return new Promise(resolveResult => {
    const child = spawn(suite.command, suite.args, {
      cwd: process.cwd(),
      env: { ...process.env, CI: '1', E2E_READONLY: '1', READ_ONLY_E2E: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk); process.stdout.write(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk); process.stderr.write(chunk) })
    child.on('error', error => resolveResult({ ...suite, status: 'failed', exitCode: null, durationMs: Date.now() - started, output: `${output}\n${String(error)}` }))
    child.on('close', code => resolveResult({ ...suite, status: code === 0 ? 'passed' : 'failed', exitCode: code, durationMs: Date.now() - started, output }))
  })
}

const { selected, skipBrowser, output } = parseArgs(process.argv.slice(2))
const selectedSuites = suites.filter(suite => (!selected || selected.includes(suite.id)) && !(skipBrowser && suite.area === 'ops-ui'))
if (selected && selectedSuites.length !== selected.length) {
  const known = new Set(suites.map(suite => suite.id))
  throw new Error(`Unknown suite in --only: ${selected.filter(id => !known.has(id)).join(', ')}`)
}
for (const suite of selectedSuites) {
  if (forbidden.test(`${suite.command} ${suite.args.join(' ')}`)) throw new Error(`Refusing non-read-only suite: ${suite.id}`)
}

const results: Result[] = []
for (const suite of selectedSuites) {
  console.log(`\n[e2e-readonly] ${suite.id} (${suite.area})`)
  results.push(await runSuite(suite))
}

const report = { generatedAt: new Date().toISOString(), readOnly: true, suites: results.map(({ output: _output, ...summary }) => summary), passed: results.filter(result => result.status === 'passed').length, failed: results.filter(result => result.status === 'failed').length }
const reportPath = resolve(output ?? 'artifacts/e2e-readonly-matrix/report.json')
await mkdir(resolve(reportPath, '..'), { recursive: true })
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(`\n[e2e-readonly] ${report.passed} passed, ${report.failed} failed; report=${reportPath}`)
process.exitCode = report.failed === 0 ? 0 : 1
