import { describe, expect, it } from 'vitest'
import { findPublishedPortConflicts, parseListeners } from '../infra/scripts/ecs-compose-published-ports.mjs'

const candidate = (hostIp = '127.0.0.1', published = '8787', protocol = 'tcp', target: number | string = 8787) => ({
  services: { api: { ports: [{ target, published, host_ip: hostIp, protocol }] } },
})
const running = (hostIp = '127.0.0.1', hostPort = '8787', project = 'local', id = 'a'.repeat(64)) => ({
  Id: id,
  Name: '/local-api-1',
  Config: { Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': 'api' } },
  HostConfig: { PortBindings: { '8787/tcp': [{ HostIp: hostIp, HostPort: hostPort }] } },
  State: { Running: true },
})

describe('ECS candidate published-port preflight', () => {
  it('rejects a published API port owned by a different running Compose project', () => {
    expect(findPublishedPortConflicts(candidate(), [running()], 'merchant-production', ['api'])).toEqual([
      expect.objectContaining({ service: 'api', start: 8787, end: 8787, owner: expect.stringContaining('local-api-1') }),
    ])
  })

  it('allows an unused host port and ignores containers the candidate project replaces', () => {
    expect(findPublishedPortConflicts(candidate(), [], 'merchant-production', ['api'])).toEqual([])
    expect(findPublishedPortConflicts(candidate(), [running('127.0.0.1', '8787', 'merchant-production')], 'merchant-production', ['api'])).toEqual([])
    const withWorker = { services: { ...candidate().services, worker: { ports: [] } } }
    expect(findPublishedPortConflicts(withWorker, [running('127.0.0.1', '8787', 'merchant-production')], 'merchant-production', ['worker'])).toHaveLength(1)
  })

  it('detects wildcard address and overlapping port-range conflicts', () => {
    expect(findPublishedPortConflicts(candidate('0.0.0.0', '8786-8788', 'tcp', '8786-8788'), [running('127.0.0.1', '8787')], 'merchant-production', ['api'])).toHaveLength(1)
    expect(findPublishedPortConflicts(candidate('127.0.0.1'), [running('0.0.0.0')], 'merchant-production', ['api'])).toHaveLength(1)
    expect(findPublishedPortConflicts(candidate('127.0.0.1'), [running('192.168.1.2')], 'merchant-production', ['api'])).toHaveLength(0)
    expect(findPublishedPortConflicts(candidate('::ffff:127.0.0.1'), [], 'merchant-production', ['api'], '', [{ hostIp: '127.0.0.1', port: '8787', protocol: 'tcp' }])).toHaveLength(1)
  })

  it('parses IPv4, IPv6, TCP, UDP and SCTP host listeners without exposing process details', () => {
    const listeners = parseListeners([
      'tcp LISTEN 0 4096 127.0.0.1:8787 0.0.0.0:*',
      'udp UNCONN 0 0 0.0.0.0:5353 0.0.0.0:*',
      'sctp LISTEN 0 128 [::1]:9899 [::]:*',
      'tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))',
    ].join('\n'))
    expect(listeners).toEqual([
      { protocol: 'tcp', hostIp: '127.0.0.1', port: '8787' },
      { protocol: 'udp', hostIp: '0.0.0.0', port: '5353' },
      { protocol: 'sctp', hostIp: '::1', port: '9899' },
      { protocol: 'tcp', hostIp: '0.0.0.0', port: '22' },
    ])
  })

  it('detects SCTP host listeners and ignores listeners on a different protocol', () => {
    const mapping = candidate('127.0.0.1', '8787', 'sctp')
    expect(findPublishedPortConflicts(mapping, [], 'merchant-production', ['api'], '', [
      { hostIp: '127.0.0.1', port: '8787', protocol: 'sctp' },
    ])).toHaveLength(1)
    expect(findPublishedPortConflicts(mapping, [], 'merchant-production', ['api'], '', [
      { hostIp: '127.0.0.1', port: '8787', protocol: 'tcp' },
    ])).toHaveLength(0)
  })

  it('allows only the explicitly handed-off external gateway container', () => {
    const gateway = running('0.0.0.0', '443', 'edge', 'b'.repeat(64))
    expect(findPublishedPortConflicts(candidate('127.0.0.1', '443'), [gateway], 'merchant-production', ['api'])).toHaveLength(1)
    expect(findPublishedPortConflicts(candidate('127.0.0.1', '443'), [gateway], 'merchant-production', ['api'], gateway.Id)).toEqual([])
    const unrelated = running('127.0.0.1', '8787', 'edge', 'c'.repeat(64))
    expect(findPublishedPortConflicts(candidate(), [unrelated], 'merchant-production', ['api'], unrelated.Id)).toHaveLength(1)
  })

  it('rejects conflicting ports within the candidate itself and unbounded host networking', () => {
    const duplicate = { services: { api: { ports: [{ target: 8787, published: '8787', host_ip: '127.0.0.1' }] }, worker: { ports: [{ target: 8788, published: '8787', host_ip: '127.0.0.1' }] } } }
    expect(findPublishedPortConflicts(duplicate, [], 'merchant-production', ['api', 'worker'])).toHaveLength(1)
    expect(() => findPublishedPortConflicts({ services: { api: { network_mode: 'host' } } }, [], 'merchant-production', ['api'])).toThrow(/host networking/)
    expect(() => findPublishedPortConflicts({}, [], 'merchant-production', ['api'])).toThrow(/must contain services/)
  })

  it('fails closed on malformed port ranges', () => {
    expect(() => findPublishedPortConflicts(candidate('127.0.0.1', '0'), [], 'merchant-production', ['api'])).toThrow(/valid port range/)
    expect(() => findPublishedPortConflicts(candidate('127.0.0.1', '9000-9002'), [], 'merchant-production', ['api'])).toThrow(/ranges differ/)
  })
})
