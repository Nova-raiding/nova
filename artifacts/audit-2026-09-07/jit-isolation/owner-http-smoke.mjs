import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync, openSync, closeSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { buildSafeTestEnvironment } from '../../../scripts/run-safe-tests.ts'
const evidenceDir = mkdtempSync(resolve('artifacts/audit-2026-09-07/jit-isolation/owner-http-smoke-'))
const storage = realpathSync(mkdtempSync(join(tmpdir(),'merchant-owner-http-smoke-')))
const environment = {...buildSafeTestEnvironment(process.env, storage),MERCHANT_TEST_APPROVED_RATES:'true'}
const startedAt = new Date().toISOString()
const stdout = openSync(join(evidenceDir,'stdout.log'),'wx',0o600)
const stderr = openSync(join(evidenceDir,'stderr.log'),'wx',0o600)
let result
try { result = spawnSync(process.execPath,['--import','tsx','tests/http-load-smoke.ts'],{env:environment,stdio:['ignore',stdout,stderr],timeout:60000}) }
finally { closeSync(stdout);closeSync(stderr);rmSync(storage,{recursive:true,force:true}) }
const text = readFileSync(join(evidenceDir,'stdout.log'),'utf8')
const marker = 'HTTP_SMOKE_SUMMARY '
const line = text.split('\n').find(line => line.startsWith(marker))
let summary
try { summary = line ? JSON.parse(line.slice(marker.length)) : JSON.parse(text.trim()) } catch { summary = null }
writeFileSync(join(evidenceDir,'run-result.json'),JSON.stringify({startedAt,finishedAt:new Date().toISOString(),exitCode:result.status,signal:result.signal,storageCleaned:!existsSync(storage),evidenceLevel:'E1 real HTTP, controlled memory, fake connectors, synthetic rates',environmentKeys:Object.keys(environment).filter(key=>!['PATH','HOME','TMPDIR'].includes(key)),summary},null,2),{flag:'wx',mode:0o600})
console.log(JSON.stringify({evidenceDir,exitCode:result.status,storageCleaned:!existsSync(storage),summary}))
process.exitCode = result.status ?? 1
