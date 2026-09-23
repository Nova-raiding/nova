import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertCandidateApi, assertCandidateGateway, candidateGatewayConfig } from '../infra/scripts/launch-ecs-candidate-tls-gateway.mjs'

const script = 'infra/scripts/launch-ecs-candidate-tls-gateway.mjs'
const apiRef = `registry.test/api@sha256:${'a'.repeat(64)}`
const gatewayRef = `registry.test/gateway@sha256:${'b'.repeat(64)}`
const apiId = 'c'.repeat(64)
const gatewayId = 'd'.repeat(64)
const apiImageId = `sha256:${'e'.repeat(64)}`
const gatewayImageId = `sha256:${'f'.repeat(64)}`
const network = 'merchant_production_default'
const releaseId = 'release-test'
const port = '18443'

function apiContainer() {
  return {
    Id: apiId, Image: apiImageId, Name: `/merchant-candidate-api-${releaseId}-abcde`, State: { Running: true },
    Config: { Labels: { 'com.docker.compose.project': 'merchant_production', 'com.docker.compose.service': 'api', 'com.docker.compose.oneoff': 'True' } },
    HostConfig: { PortBindings: {} }, NetworkSettings: { Networks: { [network]: { IPAddress: '172.20.0.8' } } },
  }
}
function gatewayContainer(name: string) {
  return {
    Id: gatewayId, Image: gatewayImageId, Name: `/${name}`, State: { Running: true },
    Config: { Labels: { 'com.storenova.candidate.api-id': apiId } },
    HostConfig: { PortBindings: { '8443/tcp': [{ HostIp: '127.0.0.1', HostPort: port }] } },
    NetworkSettings: { Networks: { [network]: { IPAddress: '172.20.0.9' } } },
  }
}
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'candidate-tls-')))
  const compose = join(dir, 'compose.json')
  const env = join(dir, 'candidate.env')
  const certDir = join(dir, 'certs')
  const calls = join(dir, 'docker-calls.jsonl')
  const nameFile = join(dir, 'gateway-name')
  const binary = join(dir, 'docker.cjs')
  spawnSync('mkdir', ['-p', certDir])
  writeFileSync(join(certDir, 'fullchain.pem'), 'test certificate placeholder')
  writeFileSync(join(certDir, 'privkey.pem'), 'test key placeholder')
  writeFileSync(compose, JSON.stringify({ networks: { default: { name: network } }, services: {
    api: { image: apiRef, environment: { RELEASE_ID: releaseId, RELEASE_GIT_SHA: '1'.repeat(40), RELEASE_IMAGE_SET_DIGEST: `sha256:${'2'.repeat(64)}` } },
    'pilot-gateway': { image: gatewayRef },
  } }))
  writeFileSync(env, 'RELEASE_ID=release-test\n')
  writeFileSync(binary, `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
const op=args[2];
if(op==='image'){process.stdout.write(args.at(-1)===${JSON.stringify(apiRef)}?${JSON.stringify(apiImageId)}:${JSON.stringify(gatewayImageId)});process.exit(0)}
if(op==='run'){fs.writeFileSync(${JSON.stringify(nameFile)},args[args.indexOf('--name')+1]);process.stdout.write(${JSON.stringify(gatewayId)});process.exit(0)}
if(op==='inspect'){
 const id=args.at(-1);
 const value=id===${JSON.stringify(apiId)}?${JSON.stringify(apiContainer())}:{...${JSON.stringify(gatewayContainer('placeholder'))},Name:'/'+fs.readFileSync(${JSON.stringify(nameFile)},'utf8')};
 process.stdout.write(JSON.stringify([value]));process.exit(0)
}
if(op==='stop'){process.stdout.write(${JSON.stringify(gatewayId)});process.exit(0)}
process.exit(1);
`)
  chmodSync(binary, 0o700)
  const args = [script, 'start', compose, env, 'merchant_production', gatewayRef, releaseId, apiId, port]
  const processEnv = { ...process.env, NODE_ENV: 'test', VITEST: 'true', CANDIDATE_TLS_TEST_DOCKER_BINARY: binary,
    CANDIDATE_TLS_TEST_CERT_DIR: certDir, CANDIDATE_TLS_TEST_UNPROTECTED_FILES: 'true', CANDIDATE_TLS_TEST_SKIP_PROBE: 'true' }
  return { args, processEnv, calls, nameFile, compose, env }
}

describe('isolated ECS candidate TLS gateway', () => {
  it('pins the only upstream to the exact API IP and denies all unrelated paths', () => {
    const conf = candidateGatewayConfig('172.20.0.8')
    expect(conf).toContain('proxy_pass http://172.20.0.8:8787/mcp;')
    expect(conf).toContain('X-MCP-OAuth-Required "true"')
    expect(conf).toContain('location / { return 404; }')
    expect(conf.match(/location = /g)).toHaveLength(3)
    expect(() => candidateGatewayConfig('172.20.0.999')).toThrow()
    expect(() => candidateGatewayConfig('api-replica')).toThrow()
  })

  it('rejects wrong API identity, image, publication and network', () => {
    const expected = { id: apiId, imageId: apiImageId, project: 'merchant_production', releaseId, network }
    expect(assertCandidateApi(apiContainer(), expected)).toBe('172.20.0.8')
    expect(() => assertCandidateApi({ ...apiContainer(), Image: gatewayImageId }, expected)).toThrow()
    expect(() => assertCandidateApi({ ...apiContainer(), HostConfig: { PortBindings: { '8787/tcp': [{ HostPort: '8787' }] } } }, expected)).toThrow()
    expect(() => assertCandidateApi({ ...apiContainer(), NetworkSettings: { Networks: {} } }, expected)).toThrow()
  })

  it('rejects any non-loopback or extra gateway publication', () => {
    const name = `merchant-candidate-tls-${releaseId}-abcde`
    const expected = { id: gatewayId, imageId: gatewayImageId, name, network, port: Number(port), apiId }
    expect(() => assertCandidateGateway(gatewayContainer(name), expected)).not.toThrow()
    expect(() => assertCandidateGateway({ ...gatewayContainer(name), HostConfig: { PortBindings: { '8443/tcp': [{ HostIp: '0.0.0.0', HostPort: port }] } } }, expected)).toThrow()
    expect(() => assertCandidateGateway({ ...gatewayContainer(name), HostConfig: { PortBindings: { '8443/tcp': [{ HostIp: '127.0.0.1', HostPort: port }], '8080/tcp': [] } } }, expected)).toThrow()
  })

  it('launches only on ECS loopback and stops only the exact gateway ID', () => {
    const value = fixture()
    const start = spawnSync('node', value.args, { env: value.processEnv, encoding: 'utf8' })
    expect(start.status, start.stderr).toBe(0)
    expect(start.stdout.trim()).toBe(gatewayId)
    const calls = readFileSync(value.calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
    const run = calls.find(call => call[2] === 'run')!
    expect(run).toContain(`127.0.0.1:${port}:8443`)
    expect(run).toContain(network)
    expect(run).toContain('--no-healthcheck')
    expect(run).not.toContain('0.0.0.0:443:8443')
    const name = readFileSync(value.nameFile, 'utf8')
    const conf = readFileSync(join(value.compose, '..', `${name}.conf`), 'utf8')
    expect(conf).toContain('172.20.0.8:8787')

    const stop = spawnSync('node', [script, 'stop', value.compose, value.env, 'merchant_production', gatewayRef, releaseId, apiId, port, gatewayId], { env: value.processEnv, encoding: 'utf8' })
    expect(stop.status, stop.stderr).toBe(0)
    expect(stop.stdout.trim()).toBe(gatewayId)
    const after = readFileSync(value.calls, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(after.at(-1)).toEqual(['--host', 'unix:///var/run/docker.sock', 'stop', '--time', '10', gatewayId])
    expect(after.some(call => call.includes('rm') || call.includes('down'))).toBe(false)
  })
})
