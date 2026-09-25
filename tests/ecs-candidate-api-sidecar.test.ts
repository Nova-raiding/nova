import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = 'infra/scripts/launch-ecs-candidate-api.mjs'
const imageRef = `registry.example.test/api@sha256:${'b'.repeat(64)}`
const containerId = 'a'.repeat(64)
const imageId = `sha256:${'c'.repeat(64)}`

function fixture(bindPort = false) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'candidate-api-sidecar-')))
  const compose = join(dir, 'rendered.json')
  const env = join(dir, 'candidate.env')
  const calls = join(dir, 'calls.jsonl')
  const binary = join(dir, 'docker.cjs')
  writeFileSync(compose, JSON.stringify({ services: { api: { image: imageRef, pull_policy: 'never', environment: {
    RELEASE_ID: 'release-test', NODE_ENV: 'production', DEPLOYMENT_PROFILE: 'ecs',
    RUN_MIGRATIONS_ON_STARTUP: 'false', CONNECTOR_FIXTURE_MODE: 'false',
    DATABASE_URL: 'postgres://app@db/merchant', OPS_DATABASE_URL: 'postgres://ops@db/merchant',
  } } } }))
  writeFileSync(env, 'RELEASE_ID=release-test\n')
  writeFileSync(binary, `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
const op=args[2];
if(op==='image'){process.stdout.write(${JSON.stringify(imageId)}+'\\n');process.exit(0)}
if(op==='compose'){const name=args[args.indexOf('--name')+1];fs.writeFileSync(${JSON.stringify(join(dir, 'name'))},name);process.stdout.write('started\\n');process.exit(0)}
if(op==='inspect'){const name=fs.readFileSync(${JSON.stringify(join(dir, 'name'))},'utf8');process.stdout.write(JSON.stringify([{
  Id:${JSON.stringify(containerId)},Name:'/'+name,Image:${JSON.stringify(imageId)},State:{Running:true},
  Config:{Labels:{'com.docker.compose.project':'merchant-production','com.docker.compose.service':'api','com.docker.compose.oneoff':'True'}},
  HostConfig:{PortBindings:${bindPort ? "{'8787/tcp':[{HostPort:'8787'}]}" : '{}'}}
}]));process.exit(0)}
if(op==='stop'){process.stdout.write(${JSON.stringify(containerId)}+'\\n');process.exit(0)}
process.exit(1);
`)
  chmodSync(binary, 0o700)
  const args = [script, 'start', compose, env, 'merchant-production', imageRef, 'release-test']
  const processEnv = { ...process.env, NODE_ENV: 'test', VITEST: 'true', CANDIDATE_SIDECAR_TEST_DOCKER_BINARY: binary, CANDIDATE_SIDECAR_TEST_UNPROTECTED_FILES: 'true' }
  return { dir, calls, args, processEnv }
}

describe('ECS candidate API sidecar', () => {
  it('uses the frozen service without publishing ports and returns a full Docker ID', () => {
    const value = fixture()
    const start = spawnSync('node', value.args, { env: value.processEnv, encoding: 'utf8' })
    expect(start.status, start.stderr).toBe(0)
    expect(start.stdout.trim()).toBe(containerId)
    const calls = readFileSync(value.calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
    const compose = calls.find(call => call[2] === 'compose')!
    expect(compose).toContain('--no-deps')
    expect(compose).not.toContain('--pull')
    expect(compose).not.toContain('--no-tty')
    expect(compose).not.toContain('--service-ports')
    expect(compose).not.toContain('--publish')
    expect(compose.at(-1)).toBe('api')
    expect(calls.findIndex(call => call[2] === 'image' && call[3] === 'inspect')).toBeLessThan(calls.indexOf(compose))

    const stop = spawnSync('node', [script, 'stop', value.args[2]!, value.args[3]!, 'merchant-production', imageRef, 'release-test', containerId], { env: value.processEnv, encoding: 'utf8' })
    expect(stop.status).toBe(0)
    expect(stop.stdout.trim()).toBe(containerId)
    const after = readFileSync(value.calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(after.at(-1)).toEqual(['--host', 'unix:///var/run/docker.sock', 'stop', '--time', '30', containerId])
    expect(after.some(call => call.includes('rm') || call.includes('down'))).toBe(false)
  })

  it('stops an unexpectedly published sidecar and refuses its ID', () => {
    const value = fixture(true)
    const start = spawnSync('node', value.args, { env: value.processEnv, encoding: 'utf8' })
    expect(start.status).not.toBe(0)
    expect(start.stdout).toBe('')
    const calls = readFileSync(value.calls, 'utf8')
    expect(calls).toContain('"stop"')
  })
})
