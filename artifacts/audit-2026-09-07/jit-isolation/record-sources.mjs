import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const phase = process.argv[2]
if (!['before-check','after-check','mid-final-check','final'].includes(phase)) throw new Error('unknown source snapshot phase')
const roots = ['apps','packages','scripts','tests','infra','demo/merchant-studio','dogfood/chatgpt-all-functions','.github','.codex-marketplace']
const files = execFileSync('rg', ['--files','--hidden',...roots,'-g','!**/node_modules/**','-g','!**/dist/**','-g','!**/screenshots/**','-g','!**/test-results/**'], { encoding: 'utf8' }).trim().split('\n').filter(file => /\.(?:ts|tsx|js|mjs|cjs|sh|sql|json|yaml|yml|html|css)$/u.test(file))
files.push('package.json','package-lock.json','tsconfig.json','vitest.config.ts','vitest.runtime.config.ts','vitest.postgres.config.ts','AGENTS.md')
const hashes = Object.fromEntries([...new Set(files)].sort().map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]))
const snapshot = { at: new Date().toISOString(), phase, head: execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(), sourceCount:Object.keys(hashes).length, digest:createHash('sha256').update(JSON.stringify(hashes)).digest('hex'), hashes }
writeFileSync(resolve('artifacts/audit-2026-09-07/jit-isolation',`source-${phase}.json`),JSON.stringify(snapshot,null,2),{mode:0o600,flag:'wx'})
console.log(JSON.stringify({phase,at:snapshot.at,sourceCount:snapshot.sourceCount,digest:snapshot.digest}))
