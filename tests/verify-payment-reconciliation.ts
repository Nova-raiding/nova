import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

export type PaymentReconciliationReport = {
  schemaVersion: number
  status: 'passed' | 'failed'
  runId: string | null
  errors: string[]
  stage: string
  failure?: { name: string; code?: string; location?: string }
  fixtureOnly: boolean
  provider: string
  realPaymentCalls: number
  realModelCalls: number
  sharedContainersTouched: boolean
  fingerprintsBefore: Record<string, string>
  fingerprintsAfter: Record<string, string>
  checks: Array<{ stage?: string; [key: string]: unknown }>
  disposal: { leftRunning?: unknown[] } | null
}

const projectRoot = resolve(import.meta.dirname, '..')

export async function runPaymentReconciliationAcceptance(): Promise<PaymentReconciliationReport> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/verify-payment-reconciliation.ts'], {
    cwd: projectRoot,
    // The acceptance itself provisions an isolated local provider/database;
    // do not let ambient payment or shared-service credentials influence it.
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref()
      reject(new Error('payment reconciliation acceptance exceeded 240 seconds'))
    }, 240_000)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('close', code => { clearTimeout(timeout); resolveExit(code) })
  })
  const match = stdout.match(/Payment reconciliation acceptance (?:passed|failed); report: (.+)\r?\n?$/mu)
  if (!match?.[1]) throw new Error(`acceptance report path missing (exit ${exitCode}); ${stderr.slice(-2000)}`)
  const reportPath = resolve(match[1])
  const rel = relative(resolve(projectRoot, 'artifacts/payment-reconciliation'), reportPath)
  if (!rel.startsWith('run-') || rel.includes('..') || !isAbsolute(reportPath)) {
    throw new Error('acceptance report escaped its owned artifacts directory')
  }
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as PaymentReconciliationReport
  if (exitCode !== 0 || report.status !== 'passed') {
    throw new Error(`payment reconciliation acceptance failed at ${report.stage}: ${report.errors.join(', ')} (${report.failure?.name ?? 'unknown'} ${report.failure?.code ?? ''} ${report.failure?.location ?? ''}); ${stderr.slice(-1000)}`)
  }
  return report
}
