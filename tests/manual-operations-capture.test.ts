import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateManualOperationsEvidence } from './manual-operations-evidence-gate.js'

function fixture(isolationStatus = '403') {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'manual-evidence-capture-')))
  const bin = join(directory, 'bin')
  mkdirSync(bin)
  const curl = join(bin, 'curl')
  writeFileSync(curl, `#!/bin/sh
set -eu
output= data= workspace= url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output=$2; shift 2 ;;
    --data) data=$2; shift 2 ;;
    -H) case "$2" in "x-workspace-id: "*) workspace=\${2#x-workspace-id: } ;; esac; shift 2 ;;
    http*) url=$1; shift ;;
    *) shift ;;
  esac
done
if [ "\${url%/releasez}" != "$url" ]; then
  printf '%s' '{"data":{"release":{"release_id":"release-test"}}}' >"$output"; printf 200; exit
fi
if [ "$workspace" = foreign-workspace ]; then
  printf '%s' '{"error":{"code":"FORBIDDEN"}}' >"$output"; printf '${isolationStatus}'; exit
fi
case "$data" in
  *publish.manual.get*) printf '%s' '{"result":{"id":"report-1","state":"manual_publish_reported"}}' >"$output" ;;
  *) printf '%s' '{"result":{"items":[{"id":"report-1","state":"manual_publish_reported"}],"total":1,"limit":20,"offset":0}}' >"$output" ;;
esac
printf 200
`)
  chmodSync(curl, 0o755)
  const output = join(directory, 'manual.json')
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, RELEASE_ID: 'release-test',
    PRODUCTION_API_BASE_URL: 'https://production.example.test', PRODUCTION_CANARY_BEARER_TOKEN: 'secret-token',
    PRODUCTION_CANARY_WORKSPACE_ID: 'target-workspace', PRODUCTION_CANARY_ISOLATION_WORKSPACE_ID: 'foreign-workspace',
    PRODUCTION_MANUAL_REPORT_ID: 'report-1', MANUAL_OPERATIONS_EVIDENCE_OUTPUT: output,
    MANUAL_OPERATIONS_VERIFIED_BY: 'release-operator',
  }
  return { output, env }
}

describe('manual operations evidence capture', () => {
  it('writes tenant- and release-bound evidence only after real response contracts pass', () => {
    const { output, env } = fixture()
    execFileSync('sh', ['infra/scripts/capture-manual-operations-evidence.sh'], { env, stdio: 'pipe' })
    const evidence = JSON.parse(readFileSync(output, 'utf8'))
    expect(evidence).toMatchObject({ release_id: 'release-test', workspace_id: 'target-workspace', manual_publish_report_id: 'report-1', simulated: false, tenant_isolation_verified: true })
    expect(validateManualOperationsEvidence(evidence, 'release-test')).toEqual([])
  })

  it('does not write evidence when the foreign-workspace negative probe succeeds', () => {
    const { output, env } = fixture('200')
    expect(() => execFileSync('sh', ['infra/scripts/capture-manual-operations-evidence.sh'], { env, stdio: 'pipe' })).toThrow()
    expect(() => readFileSync(output)).toThrow()
  })
})
