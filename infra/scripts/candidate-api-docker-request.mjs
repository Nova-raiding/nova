#!/usr/bin/env node
// Send one read-only API observation to an exact, immutable candidate container.
// The HTTP request originates inside that container, so a host loopback port
// cannot be occupied or swapped by another process between checks.
import { spawnSync } from 'node:child_process'
import { openSync, writeFileSync, closeSync, constants } from 'node:fs'
import { join } from 'node:path'

const [containerId, imageRef, route, name, workdir] = process.argv.slice(2)
const fail = message => { console.error(message); process.exit(1) }
if (!/^[0-9a-f]{64}$/.test(containerId ?? '')) fail('candidate container ID must be a full Docker ID')
if (!/^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$/.test(imageRef ?? '')) fail('candidate image must be an immutable repository digest')
if (!['/releasez', '/mcp'].includes(route) || !/^(release|target-list|target-get|isolation)$/.test(name ?? '')) fail('candidate request route is not allowlisted')
if (!workdir?.startsWith('/')) fail('candidate capture workdir must be absolute')
const testDockerBinary = process.env.MANUAL_OPERATIONS_TEST_DOCKER_BINARY
if (testDockerBinary && (process.env.NODE_ENV !== 'test' || process.env.VITEST !== 'true')) {
  fail('Docker binary overrides are forbidden outside the test runner')
}
const dockerBinary = testDockerBinary || '/usr/bin/docker'

function docker(args, input = undefined) {
  const result = spawnSync(dockerBinary, ['--host', 'unix:///var/run/docker.sock', ...args], {
    input, encoding: 'utf8', timeout: 25_000, maxBuffer: 2 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  })
  if (result.error || result.status !== 0) fail('candidate Docker inspection or request failed')
  return result.stdout.trim()
}

const expectedImageId = docker(['image', 'inspect', '--format', '{{.Id}}', imageRef])
if (!/^sha256:[0-9a-f]{64}$/.test(expectedImageId)) fail('candidate image has no valid local image ID')
const descriptor = docker(['inspect', '--type', 'container', '--format', '{{.Id}}|{{.Image}}|{{.State.Running}}', containerId]).split('|')
if (descriptor.length !== 3 || descriptor[0] !== containerId || descriptor[1] !== expectedImageId || descriptor[2] !== 'true') {
  fail('candidate container is not the running reviewed API image')
}

let input
try { input = JSON.parse(await new Promise((resolve, reject) => {
  let data = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => { data += chunk; if (data.length > 128 * 1024) reject(new Error('input too large')) })
  process.stdin.on('end', () => resolve(data))
  process.stdin.on('error', reject)
})) } catch { fail('candidate request input is invalid') }
if (!input || typeof input !== 'object' || Array.isArray(input)) fail('candidate request input is invalid')
if (route === '/releasez' && (input.token || input.workspace || input.body)) fail('release identity request must be unauthenticated')
if (route === '/mcp' && (typeof input.token !== 'string' || !input.token || typeof input.workspace !== 'string' || !input.workspace || typeof input.body !== 'string')) fail('candidate MCP request is incomplete')

const inside = `
const http=require('node:http');
let raw='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{raw+=chunk;if(raw.length>131072)process.exit(2)});
process.stdin.on('end',()=>{
  let input;try{input=JSON.parse(raw)}catch{process.exit(2)}
  const headers=input.route==='/mcp'?{'authorization':'Bearer '+input.token,'x-workspace-id':input.workspace,'content-type':'application/json'}:{};
  const req=http.request({host:'127.0.0.1',port:8787,path:input.route,method:input.route==='/mcp'?'POST':'GET',headers,timeout:20000},res=>{
    let body='';res.setEncoding('utf8');res.on('data',chunk=>{body+=chunk;if(body.length>1048576){req.destroy();process.exit(2)}});
    res.on('end',()=>process.stdout.write(JSON.stringify({status:res.statusCode,body})));
  });
  req.on('timeout',()=>req.destroy());req.on('error',()=>process.exit(2));
  if(input.route==='/mcp')req.write(input.body);
  req.end();
});`
const wire = docker(['exec', '-i', '-e', 'NODE_OPTIONS=', containerId, 'node', '-e', inside], JSON.stringify({ ...input, route }))
let response
try { response = JSON.parse(wire) } catch { fail('candidate API returned an invalid response envelope') }
if (!Number.isInteger(response?.status) || response.status < 100 || response.status > 599 || typeof response.body !== 'string') fail('candidate API returned an invalid HTTP response')
for (const [suffix, value] of [['json', response.body], ['status', String(response.status)]]) {
  const file = join(workdir, `${name}.${suffix}`)
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, value); } finally { closeSync(fd) }
}
