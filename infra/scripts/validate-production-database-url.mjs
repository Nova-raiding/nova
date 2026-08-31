#!/usr/bin/env node

import { isIP } from 'node:net'

const allowedEnvironmentNames = new Set(['DATABASE_URL', 'OPS_DATABASE_URL'])
const environmentName = process.argv[2]

function fail(message) {
  process.stderr.write(`production ${environmentName ?? 'database URL'} ${message}\n`)
  process.exit(1)
}

if (process.argv.length !== 3 || !allowedEnvironmentNames.has(environmentName)) {
  process.stderr.write('usage: validate-production-database-url.mjs <DATABASE_URL|OPS_DATABASE_URL>\n')
  process.exit(2)
}

const value = process.env[environmentName]
if (!value) fail('is required')

let url
try {
  url = new URL(value)
} catch {
  fail('must be a valid PostgreSQL URL')
}

if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
  fail('must use postgres:// or postgresql://')
}

const sslModes = url.searchParams.getAll('sslmode')
if (sslModes.length !== 1 || !['require', 'verify-ca', 'verify-full'].includes(sslModes[0])) {
  fail('must require TLS with exactly one sslmode=require, verify-ca or verify-full')
}

const parsedHostname = url.hostname
  .replace(/^\[|\]$/gu, '')
  .replace(/\.$/u, '')
  .toLowerCase()

if (!parsedHostname) fail('must specify a non-local hostname')

// PostgreSQL is a non-special URL scheme, so WHATWG leaves legacy numeric
// IPv4 spellings such as 127.1 and 2130706433 untouched. Re-run only the host
// through a special scheme to canonicalize those spellings without resolving
// DNS or making a network request.
let hostname = parsedHostname
if (isIP(parsedHostname) !== 6) {
  try {
    hostname = new URL(`http://${parsedHostname}`).hostname
      .replace(/\.$/u, '')
      .toLowerCase()
  } catch {
    fail('contains an invalid hostname')
  }
}

const localHostname = hostname === 'localhost'
  || hostname.endsWith('.localhost')
  || hostname === 'localhost.localdomain'
const ipv4 = isIP(hostname) === 4 ? hostname.split('.').map(Number) : undefined
const ipv4LoopbackOrUnspecified = Boolean(ipv4 && (ipv4[0] === 127 || ipv4.every(part => part === 0)))
const ipv6LoopbackOrUnspecified = hostname === '::1'
  || hostname === '0:0:0:0:0:0:0:1'
  || hostname === '::'
  || hostname === '0:0:0:0:0:0:0:0'
  || /^::ffff:127\./u.test(hostname)
  || /^::ffff:7f[0-9a-f]{2}:/u.test(hostname)

if (localHostname || ipv4LoopbackOrUnspecified || ipv6LoopbackOrUnspecified) {
  fail('must not use localhost, loopback, or an unspecified local address')
}
