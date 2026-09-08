import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
const output = resolve('artifacts/audit-2026-09-07/jit-isolation')
const capture = 'artifacts/ops-jit-isolation/2026-09-07T12-02-31.313Z-97066e92-893e-48e2-a755-f972387b7111'
const json = file => JSON.parse(readFileSync(file,'utf8'))
const unitReports = ['owner-integrated-entrypoints-green.json','owner-guards-postgres-entry.json','owner-summary-final.json','owner-environment-regressions.json']
const unit = unitReports.map(file => { const r=json(join(output,file));return {report:file,success:r.success,files:r.testResults.length,passed:r.numPassedTests,failed:r.numFailedTests,skippedOrPending:r.numPendingTests} })
const disposals = []
for(const parent of ['artifacts/ops-jit-isolation','artifacts/isolated-postgres']) for(const entry of readdirSync(parent,{withFileTypes:true}).filter(e=>e.isDirectory())) {
  const directory=join(parent,entry.name)
  for(const name of readdirSync(directory).filter(name=>/^fixture-disposal-.*\.json$/u.test(name))) disposals.push({path:join(directory,name),...json(join(directory,name))})
}
const liveIds = new Set(execFileSync('docker',['--host','unix:///Users/lixiaomei/.colima/default/docker.sock','ps','--all','--no-trunc','--format','{{.ID}}'],{encoding:'utf8'}).trim().split('\n'))
const stoppedIds = disposals.flatMap(d=>d.stopped)
const healthText=execFileSync('docker',['--host','unix:///Users/lixiaomei/.colima/default/docker.sock','ps','--filter','label=com.docker.compose.project=local','--format','{{.Names}}\t{{.Status}}'],{encoding:'utf8'})
const sharedDependencyState=execFileSync('docker',['--host','unix:///Users/lixiaomei/.colima/default/docker.sock','inspect','--format','{"name":{{json .Name}},"startedAt":{{json .State.StartedAt}},"oomKilled":{{json .State.OOMKilled}},"restartCount":{{json .RestartCount}},"status":{{json .State.Status}},"health":{{json .State.Health.Status}}}','local-clamav-1','local-redis-1','local-postgres-1'],{encoding:'utf8'}).trim().split('\n').map(JSON.parse)
const snapshots = ['before-check','after-check','mid-final-check','final'].map(phase=>json(join(output,`source-${phase}.json`)))
const changes = snapshots.slice(1).map((b,index)=>{const a=snapshots[index];return {from:a.phase,to:b.phase,added:Object.keys(b.hashes).filter(k=>!a.hashes[k]),changed:Object.keys(b.hashes).filter(k=>a.hashes[k]&&a.hashes[k]!==b.hashes[k]),removed:Object.keys(a.hashes).filter(k=>!b.hashes[k])}})
const artifacts = [
  ...unitReports.map(file=>join(output,file)),join(output,'owner-full-check.log'),join(output,'owner-full-check-final.log'),join(output,'owner-release-gates.log'),
  'artifacts/isolated-postgres/run-c59WPX/vitest.json','artifacts/isolated-postgres/run-c59WPX/run-result.json',
  join(capture,'playwright.json'),join(capture,'runtime.json'),
  ...['capture-summary.json','postgres-readonly.redacted.json','shot-scraper.redacted.json','jit-signed-login-issue-revoke-denied.mp4','frame-03-invalid-ttl-submit.png','02-issued-and-explicitly-refreshed.png','04-revoke-denied-input-retained.png'].map(name=>join(capture,'live-desktop-capture',name)),
].filter(existsSync)
const hashes=Object.fromEntries(artifacts.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]))
const playwright=json(join(capture,'playwright.json'))
const manifest={
  schemaVersion:1,finishedAt:new Date().toISOString(),scope:'Desktop JIT issue form and hermetic test entrypoints; no authorization-policy change',
  unit,postgres:json('artifacts/isolated-postgres/run-c59WPX/run-result.json'),desktop:{stats:playwright.stats,capture:json(join(capture,'live-desktop-capture/capture-summary.json')),runtime:json(join(capture,'runtime.json'))},
  logSummaries:['owner-full-check.log','owner-full-check-final.log','owner-release-gates.log'].map(file=>({file,summaryLines:readFileSync(join(output,file),'utf8').split('\n').filter(line=>/Test Files|Tests\s+[0-9]|Duration\s|^> merchant.*(typecheck|build|check)/u.test(line))})),
  sourceSnapshots:snapshots.map(({hashes,...metadata})=>metadata),sourceChanges:changes,
  cleanup:{disposals,stoppedIdsStillPresent:stoppedIds.filter(id=>liveIds.has(id)),leftForReview:disposals.flatMap(d=>d.leftRunning),syntheticDataRebuildable:true,evidenceRetained:true},
  sharedRuntimeReadOnlySnapshot:{at:new Date().toISOString(),containers:healthText.trim().split('\n'),dependencies:sharedDependencyState,note:'Point-in-time health only, not stability certification; ClamAV restart cause was not investigated in this scope.'},
  nonHermeticDenominator:{defaultExcludedFiles:13,isolatedPostgresFiles:8,explicitRuntimeFiles:4,runtimeScenarios:9,legacyCanonicalApiFiles:1,legacyCanonicalApiScenarios:6},
  externalAcceptance:{paidModelCalls:0,productionDeployed:false,sharedBusinessDatabaseMigrated:false,realChatGptHostVerified:false,officialIdpVerified:false},
  verdict:'NO-GO: revoke approval/schema conflict; dedicated remaining runtime and external E3/E4 gates incomplete; dirty moving workspace is not a frozen release',artifactSha256:hashes,
}
writeFileSync(join(output,'run-manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600})
console.log(JSON.stringify({manifest:join(output,'run-manifest.json'),unit,cleanupLeft:manifest.cleanup.leftForReview,stoppedIdsStillPresent:manifest.cleanup.stoppedIdsStillPresent,sourceChanges:changes,desktop:playwright.stats},null,2))
