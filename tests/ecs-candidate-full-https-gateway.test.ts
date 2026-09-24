import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertCandidateFullGateway, assertCandidateUpstream } from '../infra/scripts/launch-ecs-candidate-full-https-gateway.mjs'

const script = 'infra/scripts/launch-ecs-candidate-full-https-gateway.mjs'
const project = 'merchant_candidate'
const releaseId = 'release-full-tls'
const network = `${project}_default`
const networkId = 'a'.repeat(64)
const gatewayRef = `registry.test/gateway@sha256:${'b'.repeat(64)}`
const gatewayId = 'c'.repeat(64)
const gatewayImageId = `sha256:${'d'.repeat(64)}`
const port = '18443'
const certDirName = 'certs'
const services = ['api-replica', 'ui', 'ops-ui', 'payment-gateway'] as const
const imageRefs = Object.fromEntries(services.map((name, index) => [name, `registry.test/${name}@sha256:${String(index + 1).repeat(64)}`]))
const imageIds = Object.fromEntries(services.map((name, index) => [imageRefs[name], `sha256:${String(index + 5).repeat(64)}`]))
const serviceIds = Object.fromEntries(services.map((name, index) => [name, String(index + 1).repeat(64)]))

function gatewayContainer(name: string, certDir: string) {
  return {
    Id: gatewayId, Image: gatewayImageId, Name: `/${name}`, State: { Running: true },
    Config: { Image: gatewayRef, Labels: {
      'com.storenova.candidate.full-https-gateway': 'true',
      'com.storenova.candidate.project': project,
      'com.storenova.candidate.release-id': releaseId,
      'com.storenova.candidate.network-id': networkId,
    } },
    HostConfig: { NetworkMode: network, PortBindings: { '8443/tcp': [{ HostIp: '127.0.0.1', HostPort: port }] } },
    NetworkSettings: { Networks: { [network]: { NetworkID: networkId, Aliases: [name] } } },
    Mounts: [{ Type: 'bind', Source: certDir, Destination: '/etc/nginx/certs', RW: false }],
  }
}

function upstreamContainer(service: typeof services[number]) {
  const imageRef = imageRefs[service]
  return {
    Id: serviceIds[service], Image: imageIds[imageRef], Name: `/candidate-${service}-1`, State: { Running: true },
    Config: { Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': service } },
    HostConfig: { PortBindings: {} },
    NetworkSettings: { Networks: { [network]: { NetworkID: networkId, Aliases: [service] } } },
  }
}

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'candidate-full-tls-')))
  const composePath = join(dir, 'compose.json')
  const envPath = join(dir, 'candidate.env')
  const certDir = join(dir, certDirName)
  const callsPath = join(dir, 'docker-calls.jsonl')
  const namePath = join(dir, 'gateway-name')
  const binary = join(dir, 'docker.cjs')
  spawnSync('mkdir', ['-p', certDir])
  writeFileSync(join(certDir, 'fullchain.pem'), 'placeholder')
  writeFileSync(join(certDir, 'privkey.pem'), 'placeholder')
  const compose = {
    networks: { default: { name: network } },
    services: {
      'api-replica': { image: imageRefs['api-replica'], environment: {
        RELEASE_ID: releaseId, RELEASE_GIT_SHA: '1'.repeat(40), RELEASE_MANIFEST_SHA256: '2'.repeat(64),
        RELEASE_IMAGE_SET_DIGEST: `sha256:${'3'.repeat(64)}`,
      } },
      ui: { image: imageRefs.ui }, 'ops-ui': { image: imageRefs['ops-ui'] },
      'payment-gateway': { image: imageRefs['payment-gateway'] },
      'pilot-gateway': { image: gatewayRef, ports: [
        { target: 8080, published: '80', protocol: 'tcp' }, { target: 8443, published: '443', protocol: 'tcp' },
      ] },
    },
  }
  writeFileSync(composePath, JSON.stringify(compose))
  writeFileSync(envPath, 'candidate=true\n')
  writeFileSync(binary, `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)},JSON.stringify(args)+'\\n');
const serviceIds=${JSON.stringify(serviceIds)};
const op=args[2];
if(op==='network'&&args[3]==='inspect'){process.stdout.write(JSON.stringify([{Id:${JSON.stringify(networkId)},Driver:'bridge',Scope:'local'}]));process.exit(0)}
if(op==='image'&&args[3]==='inspect'){const ref=args.at(-1);const value=ref===${JSON.stringify(gatewayRef)}?${JSON.stringify(gatewayImageId)}:${JSON.stringify(imageIds)}[ref];if(!value)process.exit(1);process.stdout.write(value);process.exit(0)}
if(op==='ps'){const service=args.find(x=>x.startsWith('label=com.docker.compose.service='))?.split('=').at(-1);if(!serviceIds[service])process.exit(1);process.stdout.write(serviceIds[service]);process.exit(0)}
if(op==='inspect'){const id=args.at(-1);const certDir=${JSON.stringify(certDir)};let value;if(id===${JSON.stringify(gatewayId)}){value=${JSON.stringify(gatewayContainer('placeholder', certDir))};value.Name='/'+fs.readFileSync(${JSON.stringify(namePath)},'utf8')}else value=${JSON.stringify(Object.fromEntries(services.map(name=>[serviceIds[name],upstreamContainer(name)])))}[id];if(!value)process.exit(1);process.stdout.write(JSON.stringify([value]));process.exit(0)}
if(op==='run'){const name=args[args.indexOf('--name')+1];fs.writeFileSync(${JSON.stringify(namePath)},name);process.stdout.write(${JSON.stringify(gatewayId)});process.exit(0)}
if(op==='stop'){process.stdout.write(${JSON.stringify(gatewayId)});process.exit(0)}
process.exit(1);
`)
  chmodSync(binary, 0o700)
  const args = [script, 'start', composePath, envPath, project, gatewayRef, releaseId, port]
  const processEnv = { ...process.env, NODE_ENV: 'test', VITEST: 'true',
    CANDIDATE_FULL_GATEWAY_TEST_DOCKER_BINARY: binary,
    CANDIDATE_FULL_GATEWAY_TEST_CERT_DIR: certDir,
    CANDIDATE_FULL_GATEWAY_TEST_UNPROTECTED_FILES: 'true',
    CANDIDATE_FULL_GATEWAY_TEST_SKIP_PROBE: 'true' }
  return { args, processEnv, composePath, callsPath, namePath, certDir, envPath }
}

describe('loopback-only full candidate HTTPS gateway', () => {
  it('accepts only exact upstream containers on the frozen candidate network', () => {
    const container = upstreamContainer('api-replica')
    expect(() => assertCandidateUpstream(container, { id: container.Id, imageId: container.Image, project,
      service: 'api-replica', network, networkId })).not.toThrow()
    expect(() => assertCandidateUpstream({ ...container, Image: gatewayImageId }, { id: container.Id,
      imageId: container.Image, project, service: 'api-replica', network, networkId })).toThrow()
    expect(() => assertCandidateUpstream({ ...container, NetworkSettings: { Networks: { [network]: { NetworkID: 'f'.repeat(64), Aliases: ['api-replica'] } } } }, {
      id: container.Id, imageId: container.Image, project, service: 'api-replica', network, networkId,
    })).toThrow()
    expect(() => assertCandidateUpstream({ ...container, NetworkSettings: { Networks: { [network]: { NetworkID: networkId, Aliases: [] } } } }, {
      id: container.Id, imageId: container.Image, project, service: 'api-replica', network, networkId,
    })).toThrow()
  })

  it('rejects non-loopback, extra, wrong-image, wrong-network or wrong-certificate mounts', () => {
    const name = `merchant-candidate-full-https-${releaseId}-abcde`
    const value = fixture()
    const expected = { id: gatewayId, imageId: gatewayImageId, imageRef: gatewayRef, name, project, releaseId,
      network, networkId, port: Number(port), certDir: value.certDir }
    expect(() => assertCandidateFullGateway(gatewayContainer(name, value.certDir), expected)).not.toThrow()
    const base = gatewayContainer(name, value.certDir)
    expect(() => assertCandidateFullGateway({ ...base, HostConfig: { ...base.HostConfig,
      PortBindings: { '8443/tcp': [{ HostIp: '0.0.0.0', HostPort: port }] } } }, expected)).toThrow()
    expect(() => assertCandidateFullGateway({ ...base, HostConfig: { ...base.HostConfig,
      PortBindings: { ...base.HostConfig.PortBindings, '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18080' }] } } }, expected)).toThrow()
    expect(() => assertCandidateFullGateway({ ...base, Image: 'sha256:' + 'e'.repeat(64) }, expected)).toThrow()
    expect(() => assertCandidateFullGateway({ ...base, Mounts: [{ ...base.Mounts[0], RW: true }] }, expected)).toThrow()
    expect(() => assertCandidateFullGateway({ ...base, NetworkSettings: { Networks: {} } }, expected)).toThrow()
  })

  it('runs the unchanged full image only on candidate-network loopback and stops exact ID', () => {
    const value = fixture()
    const start = spawnSync('node', value.args, { env: value.processEnv, encoding: 'utf8' })
    expect(start.status, `${start.stderr}\n${readFileSync(value.callsPath, 'utf8')}`).toBe(0)
    expect(start.stdout.trim()).toBe(gatewayId)
    const calls = readFileSync(value.callsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
    const run = calls.find(call => call[2] === 'run')!
    expect(run).toContain(`127.0.0.1:${port}:8443`)
    expect(run).toContain(network)
    expect(run).toContain(`type=bind,src=${value.certDir},dst=/etc/nginx/certs,readonly`)
    expect(run.at(-1)).toBe(gatewayRef)
    expect(run).not.toContain('--entrypoint')
    expect(run.some(arg => arg.includes('default.conf') || arg.includes('pilot-gateway-https.conf'))).toBe(false)
    expect(run.some(arg => arg.startsWith('0.0.0.0:') || arg.startsWith('::'))).toBe(false)

    const name = readFileSync(value.namePath, 'utf8')
    const stop = spawnSync('node', [script, 'stop', value.composePath, value.envPath, project, gatewayRef, releaseId, port, gatewayId], {
      env: value.processEnv, encoding: 'utf8',
    })
    expect(stop.status, stop.stderr).toBe(0)
    expect(stop.stdout.trim()).toBe(gatewayId)
    const after = readFileSync(value.callsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(after.at(-1)).toEqual(['--host', 'unix:///var/run/docker.sock', 'stop', '--time', '10', gatewayId])
    expect(name).toMatch(new RegExp(`^merchant-candidate-full-https-${releaseId}-[a-f0-9]{10}$`))
    expect(after.some(call => call.includes('rm') || call.includes('down'))).toBe(false)
  })

  it('rejects an invalid public port map before any Docker operation', () => {
    const value = fixture()
    const compose = JSON.parse(readFileSync(value.composePath, 'utf8'))
    compose.services['pilot-gateway'].ports = [{ target: 8443, published: '443', protocol: 'tcp' }]
    writeFileSync(value.composePath, JSON.stringify(compose))
    const result = spawnSync('node', value.args, { env: value.processEnv, encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('frozen full HTTPS gateway must declare only HTTP 80 and HTTPS 443 targets')
    expect(existsSync(value.callsPath)).toBe(false)
  })
})
