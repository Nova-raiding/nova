import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  HTTP_OPERATION_POLICIES,
  HTTP_ROUTE_COVERAGE_EXEMPTIONS,
  assertHttpOperationPolicyCoverage,
  getHttpOperationPolicy,
  type DispatchedHttpOperation,
  type HttpMethod,
} from '../packages/contracts/src/http-authz.js'

/**
 * The HTTP authorization registry and the router have drifted before: routes
 * existed in `apps/api/src/server.ts` that `HTTP_OPERATION_POLICIES` never
 * heard about, and nothing noticed because the two were only ever compared by
 * hand.
 *
 * This file removes the hand comparison. It reads the dispatcher source and
 * derives the operations the server actually routes, then asks the registry to
 * prove it covers them. Nothing here restates the route list: a second copy
 * would drift in exactly the same way, only with a shorter half-life.
 */

const SERVER_SOURCE_URL = new URL('../apps/api/src/server.ts', import.meta.url)
const API_DIRECTORY_URL = new URL('../apps/api/src/', import.meta.url)
const HTTP_MODULE_END = '// __HTTP_MODULE_END__'

const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
/** Sentinel standing in for a path parameter while a pattern is expanded. */
const PARAM = '\u0000'

/**
 * The router function and the two helpers that decide which authentication
 * boundary a request gets. Everything else in the file is a handler, a type or
 * unrelated string data, and scanning it would only add noise. Each slice is
 * bounded by the next top-level declaration so a reordering inside the router
 * cannot silently truncate the scan.
 */
type DispatchIdiom = 'literal' | 'match' | 'test'

const DISPATCH_REGIONS: readonly { label: string, start: string, ends: readonly string[], idioms: readonly DispatchIdiom[] }[] = [
  {
    label: 'routeWithRequestContext',
    start: 'async function routeWithRequestContext(',
    ends: ['function requestFailureMetadata(', 'export function authorizationRepositoryDomainError('],
    idioms: ['literal', 'match'],
  },
  {
    label: 'isWorkerRoute',
    start: 'function isWorkerRoute(',
    ends: ['function isAssetScannerRoute('],
    idioms: ['test'],
  },
  {
    label: 'isAssetScannerRoute',
    start: 'function isAssetScannerRoute(',
    ends: ['async function requireAssetScannerAuthorization('],
    idioms: ['test'],
  },
]

function readServerSource(): string {
  const server = readFileSync(SERVER_SOURCE_URL, 'utf8')
  const modules = readdirSync(API_DIRECTORY_URL)
    .filter(name => /^http-.*routes\.ts$/u.test(name) && server.includes(`'./${name.slice(0, -3)}.js'`))
    .map(name => readFileSync(new URL(name, API_DIRECTORY_URL), 'utf8'))
  return [server, ...modules.map(module => `${module}\n${HTTP_MODULE_END}`)].join('\n')
}

function sliceRegion(lines: string[], start: string, ends: readonly string[]): { startIndex: number, lines: string[] } {
  const startIndex = lines.findIndex(line => line.includes(start))
  if (startIndex < 0) throw new Error(`apps/api/src/server.ts no longer declares ${start}`)
  let endIndex = lines.length
  for (const marker of ends) {
    const index = lines.findIndex((line, offset) => offset > startIndex && line.startsWith(marker))
    if (index > 0) endIndex = Math.min(endIndex, index)
  }
  return { startIndex, lines: lines.slice(startIndex, endIndex) }
}

function methodsIn(text: string): HttpMethod[] {
  const found = new Set<HttpMethod>()
  for (const match of text.matchAll(/req\.method\s*===\s*'([A-Z]+)'/gu)) {
    if (HTTP_METHODS.includes(match[1] as HttpMethod)) found.add(match[1] as HttpMethod)
  }
  return [...found]
}

function methodsInWorkerGuard(text: string): HttpMethod[] {
  const found = new Set<HttpMethod>(methodsIn(text))
  for (const match of text.matchAll(/\bmethod\s*===\s*'([A-Z]+)'/gu)) {
    if (HTTP_METHODS.includes(match[1] as HttpMethod)) found.add(match[1] as HttpMethod)
  }
  return [...found]
}

/**
 * The guard an occurrence belongs to. A route guard is usually one line, but
 * `const x = req.method === 'GET'` + `&& (path === a || path === b)` on the
 * next one is the same statement, so continue while the previous line is an
 * obvious continuation rather than the start of something new.
 */
function guardWindow(lines: string[], lineIndex: number): string {
  let start = lineIndex
  while (start > 0 && /^(?:\?|:|&&|\|\||\)|\]|\})/u.test(lines[start - 1]!.trim())) start -= 1
  return lines.slice(start, lineIndex + 1).join('\n')
}

interface RawOccurrence {
  /** Anchored regex literal, or a plain path for the `path === '...'` form. */
  source: string
  isRegex: boolean
  methods: HttpMethod[]
  variableName?: string
  lineNumber: number
}

function collectOccurrences(lines: string[]): RawOccurrence[] {
  const occurrences: RawOccurrence[] = []
  const moduleRegions = lines.flatMap(line => {
    const declaration = /^export (?:async )?function ((?:handle|route)[A-Za-z]+)\(/u.exec(line)
    return declaration ? [{ label: declaration[1]!, start: declaration[0], ends: [HTTP_MODULE_END], idioms: ['literal', 'match'] as const }] : []
  })
  for (const region of [...DISPATCH_REGIONS, ...moduleRegions]) {
    const sliced = sliceRegion(lines, region.start, region.ends)
    for (const [offset, line] of sliced.lines.entries()) {
      const lineIndex = sliced.startIndex + offset
      const lineNumber = lineIndex + 1
      const windowMethods = region.idioms.includes('literal') ? methodsIn(guardWindow(lines, lineIndex)) : []
      if (region.idioms.includes('literal')) {
        const directMethods = new Map<string, HttpMethod[]>()
        for (const paired of line.matchAll(/req\.method\s*===\s*'([A-Z]+)'\s*&&\s*path\s*===\s*'([^']+)'/gu)) {
          if (HTTP_METHODS.includes(paired[1] as HttpMethod)) directMethods.set(paired[2]!, [...(directMethods.get(paired[2]!) ?? []), paired[1] as HttpMethod])
        }
        for (const match of line.matchAll(/path\s*===\s*'([^']+)'/gu)) {
          occurrences.push({ source: match[1]!, isRegex: false, methods: directMethods.get(match[1]!) ?? windowMethods, lineNumber })
        }
      }
      if (region.idioms.includes('match')) {
        const assigned = /const\s+([A-Za-z0-9_]+)\s*=\s*path\.match\(\s*(\/\^[\s\S]*?\/[a-z]*)\s*\)/u.exec(line)
        const inline = /path\.match\(\s*(\/\^[^\n]*?\/[a-z]*)\s*\)/u.exec(line)
        const source = assigned?.[2] ?? inline?.[1]
        if (source) {
          occurrences.push({ source, isRegex: true, methods: methodsIn(line), variableName: assigned?.[1], lineNumber })
        }
      }
      if (region.idioms.includes('test')) {
        for (const match of line.matchAll(/\/\^[^\n]*?\/[a-z]*\.test\(path\)/gu)) {
          occurrences.push({ source: match[0].replace(/\.test\(path\)$/u, ''), isRegex: true, methods: methodsInWorkerGuard(line), lineNumber })
        }
      }
    }
  }
  return occurrences
}

/**
 * A `path.match()` result is usually consumed a few lines later by the guard
 * that gives it a method (`if (req.method === 'GET' && assetDownloadMatch)`).
 * Resolving the variable recovers per-method coverage for the regex routes;
 * when it cannot be resolved the operation stays method-agnostic and the
 * registry only has to cover the path.
 */
function methodsForVariable(lines: string[], name: string): HttpMethod[] {
  const found = new Set<HttpMethod>()
  const namePattern = new RegExp(`\\b${name}\\b`, 'u')
  const pairedPattern = new RegExp(`req\\.method\\s*===\\s*'([A-Z]+)'\\s*&&\\s*${name}\\b`, 'gu')
  for (const line of lines) {
    if (!namePattern.test(line) || !/req\.method/u.test(line)) continue
    const paired = [...line.matchAll(pairedPattern)].map(match => match[1] as HttpMethod).filter(method => HTTP_METHODS.includes(method))
    for (const method of paired.length ? paired : methodsIn(line)) found.add(method)
  }
  return [...found]
}

/** Split a regex body into literal runs, alternation groups and parameters. */
function splitPattern(body: string): Array<{ type: 'literal', value: string } | { type: 'group', alternatives: string[] } | { type: 'param' }> | undefined {
  const parts: Array<{ type: 'literal', value: string } | { type: 'group', alternatives: string[] } | { type: 'param' }> = []
  let buffer = ''
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]!
    if (character === '\\') { buffer += character + (body[index + 1] ?? ''); index += 1; continue }
    if (character !== '(') { buffer += character; continue }
    let depth = 0
    let close = index
    for (; close < body.length; close += 1) {
      if (body[close] === '\\') { close += 1; continue }
      if (body[close] === '(') depth += 1
      else if (body[close] === ')') { depth -= 1; if (depth === 0) break }
    }
    const inner = body.slice(index + 1, close)
    const group = inner.startsWith('?:') ? inner.slice(2) : inner
    if (buffer) { parts.push({ type: 'literal', value: buffer }); buffer = '' }
    if (group.includes('|') && !group.includes('(')) parts.push({ type: 'group', alternatives: group.split('|') })
    else if (/^\[\^\/\](?:\+|\{1,\})$/u.test(group)) parts.push({ type: 'param' })
    else return undefined
    index = close
  }
  if (buffer) parts.push({ type: 'literal', value: buffer })
  return parts
}

/**
 * Expand one dispatch pattern into the concrete paths it can route, so a
 * pattern is compared against the registry by the paths it actually serves
 * rather than by its source text. `(billing|subscriptions|commercial)` therefore
 * has to be registered for all three branches, not just the one that happens to
 * read well.
 *
 * Returns `undefined` for a pattern that is not a route guard at all — an
 * unanchored regex such as `^/v1/tasks/([^/]+)(?:/|$)` groups a request by
 * prefix and never dispatches by itself.
 */
function expandPattern(source: string): string[] | undefined {
  const body = source.slice(1, source.lastIndexOf('/'))
  const anchored = /^\^([\s\S]*)\$$/u.exec(body)
  if (!anchored) return undefined
  const parts = splitPattern(anchored[1]!)
  if (!parts) return undefined
  let samples = ['']
  for (const part of parts) {
    if (part.type === 'literal') {
      const value = part.value.replace(/\\\//gu, '/').replace(/\\\./gu, '.').replace(/\[\^\/\](?:\+|\{1,\})/gu, PARAM)
      if (value.includes('\\')) return undefined
      samples = samples.map(sample => sample + value)
    } else if (part.type === 'param') {
      samples = samples.map(sample => `${sample}${PARAM}`)
    } else {
      samples = samples.flatMap(sample => part.alternatives.map(alternative => `${sample}${alternative}`))
    }
  }
  return [...new Set(samples.map(sample => sample.split(PARAM).join('sample')))]
}

/**
 * `source` exists so the drift probe below can run the *same* parser and the
 * same registry over the real router text with one route added, without writing
 * to the server file it is read from.
 */
export function dispatchedHttpOperations(source: string = readServerSource()): DispatchedHttpOperation[] {
  const lines = source.split('\n')
  const operations = new Map<string, DispatchedHttpOperation>()
  for (const occurrence of collectOccurrences(lines)) {
    const samples = occurrence.isRegex ? expandPattern(occurrence.source) : [occurrence.source]
    if (!samples) continue
    const methods = occurrence.methods.length
      ? occurrence.methods
      : occurrence.variableName ? methodsForVariable(lines, occurrence.variableName) : []
    for (const sample of samples) {
      const method = methods.length === 1 ? methods[0] : undefined
      const key = `${method ?? '*'} ${sample}`
      const evidence = `apps/api/src/server.ts:${occurrence.lineNumber}`
      const previous = operations.get(key)
      operations.set(key, {
        ...(method ? { method } : {}),
        path: sample,
        evidence: previous ? `${previous.evidence},${evidence}` : evidence,
      })
      if (methods.length > 1) {
        // A guard that accepts several methods is checked once per method: the
        // registry has to cover every method the router will actually serve.
        for (const alternative of methods) {
          const alternativeKey = `${alternative} ${sample}`
          const existing = operations.get(alternativeKey)
          operations.set(alternativeKey, { method: alternative, path: sample, evidence: existing ? `${existing.evidence},${evidence}` : evidence })
        }
      }
    }
  }
  return [...operations.values()]
}

describe('HTTP route authorization coverage', () => {
  const dispatched = dispatchedHttpOperations()

  it('derives a non-trivial dispatched inventory from the router source', () => {
    // Guards the derivation itself: if a refactor moves the router behind a new
    // declaration the scan silently returns nothing and every other assertion in
    // this file would pass vacuously.
    expect(dispatched.length).toBeGreaterThan(80)
    expect(dispatched.some(operation => operation.path === '/mcp')).toBe(true)
    expect(dispatched.some(operation => operation.path === '/v1/tasks/sample')).toBe(true)
    expect(dispatched.some(operation => operation.path.startsWith('/v1/internal/'))).toBe(true)
    expect(dispatched.some(operation => operation.path.startsWith('/v1/oauth/callback/'))).toBe(true)
  })

  it('registers every route the server dispatches, or exempts it with a reason', () => {
    expect(() => assertHttpOperationPolicyCoverage(dispatched)).not.toThrow()
    expect(assertHttpOperationPolicyCoverage(dispatched)).toEqual({
      registered: HTTP_OPERATION_POLICIES.length,
      identity: HTTP_OPERATION_POLICIES.filter(policy => policy.authentication === 'identity').length,
    })
  })

  it('fails closed when the dispatcher serves a route the registry does not know', () => {
    const probe: DispatchedHttpOperation = { method: 'POST', path: '/v1/security/drift-probe', evidence: 'drift probe' }
    expect(() => assertHttpOperationPolicyCoverage([...dispatched, probe]))
      .toThrow(/HTTP routes dispatched by apps\/api\/src\/server\.ts without an authorization policy: POST \/v1\/security\/drift-probe \[drift probe\]/u)
    // Method-agnostic dispatch is checked against every HTTP method.
    expect(() => assertHttpOperationPolicyCoverage([...dispatched, { ...probe, method: undefined }])).toThrow(/HTTP routes dispatched/u)
    expect(() => assertHttpOperationPolicyCoverage([...dispatched, { method: 'POST', path: '/v1/tasks', evidence: 'registered path probe' }])).not.toThrow()
  })

  it('goes red when the router starts dispatching a route with no policy', () => {
    // Run the real parser over the real router text with one route added, so
    // this proves the gate against the actual source rather than against a
    // fixture. The injected guard is deliberately not valid TypeScript: only the
    // dispatch shape matters, and the injection never reaches disk.
    const source = readServerSource()
    const anchor = 'async function routeWithRequestContext(req: IncomingMessage, res: ServerResponse) {'
    expect(source).toContain(anchor)
    const injected = source.replace(
      anchor,
      `${anchor}\n  if (req.method === 'POST' && path === '/v1/security/drift-probe') { return send(res, 204, 'unknown', null, null, req) }`,
    )
    const drifted = dispatchedHttpOperations(injected)
    expect(drifted.some(operation => operation.path === '/v1/security/drift-probe')).toBe(true)
    expect(() => assertHttpOperationPolicyCoverage(drifted)).toThrow(/POST \/v1\/security\/drift-probe/u)
  })

  it('rejects an exemption whose route is no longer dispatched', () => {
    expect(HTTP_ROUTE_COVERAGE_EXEMPTIONS.length).toBeGreaterThan(0)
    expect(() => assertHttpOperationPolicyCoverage([
      { method: 'GET', path: '/healthz', evidence: 'stale exemption probe' },
    ])).toThrow(/exemptions no longer dispatched/u)
  })

  it('keeps the previously unregistered operations bound to their real auth boundary', () => {
    // Commercial settlement callback: HMAC + timestamp + single-use nonce, not
    // a merchant bearer. Registering it as identity would break settlement.
    expect(getHttpOperationPolicy('POST', '/v1/commercial/callback/alipay')).toMatchObject({ authentication: 'payment_callback' })
    expect(getHttpOperationPolicy('POST', '/v1/commercial/callback/wechat')).toMatchObject({ authentication: 'payment_callback' })
    expect(getHttpOperationPolicy('POST', '/v1/commercial/callback/alipay')?.mcpMethod).toBeUndefined()
    // Platform account provisioning: authenticated identity plus an operations
    // role, with no merchant MCP equivalent.
    expect(getHttpOperationPolicy('POST', '/v1/ops/merchant-accounts')).toMatchObject({ authentication: 'identity', identityOnly: true })
    // Worker-owned internal routes: worker bearer plus request signing.
    for (const path of ['/v1/internal/billing/reconciliation', '/v1/internal/knowledge-embeddings/admission', '/v1/internal/knowledge-embeddings/outcome']) {
      expect(getHttpOperationPolicy('POST', path), path).toMatchObject({ authentication: 'worker' })
      expect(getHttpOperationPolicy('GET', path), `${path} must stay POST-only`).toBeUndefined()
    }
    expect(getHttpOperationPolicy('POST', '/v1/internal/knowledge/generation-claims')).toMatchObject({ authentication: 'worker' })
    expect(getHttpOperationPolicy('PATCH', '/v1/internal/knowledge/generation-claims/claim-1')).toMatchObject({ authentication: 'worker' })
    expect(getHttpOperationPolicy('PATCH', '/v1/internal/knowledge/generation-claims')).toBeUndefined()
    expect(getHttpOperationPolicy('POST', '/v1/internal/knowledge/generation-claims/claim-1')).toBeUndefined()
    expect(getHttpOperationPolicy('GET', '/v1/internal/knowledge/generation-claims/claim-1')).toBeUndefined()
  })

  it('keeps the newly registered routes on authentication kinds that add no enforcement', () => {
    // Registering a route feeds `enforceRegisteredHttpCapability`, and a
    // registered `identity` policy additionally turns on the workspace-member,
    // customer-delivery and commercial-access gates. These routes are served
    // behind boundaries that already exist in the router, so the
    // registration must not introduce a second one:
    //   - the payment callback is skipped by every one of those gates because
    //     the router matches it as `paymentCallbackMatch`;
    //   - worker routes are skipped because the router matches them as
    //     `workerRoute`;
    //   - the platform provisioning route is `identityOnly`, so no MCP
    //     capability is resolved for it.
    for (const operation of [
      'http:POST:/v1/commercial/callback/{channel}',
      'http:POST:/v1/internal/billing/reconciliation',
      'http:POST:/v1/internal/knowledge-embeddings/admission',
      'http:POST:/v1/internal/knowledge-embeddings/outcome',
    ]) {
      const policy = HTTP_OPERATION_POLICIES.find(candidate => candidate.operation === operation)
      expect(policy, `${operation} must stay registered`).toBeDefined()
      expect(policy!.authentication, `${operation} must not become an identity operation`).not.toBe('identity')
      expect(policy!.mcpMethod, `${operation} must not reference an MCP capability`).toBeUndefined()
    }
    expect(HTTP_OPERATION_POLICIES.find(candidate => candidate.operation === 'http:POST:/v1/ops/merchant-accounts'))
      .toMatchObject({ authentication: 'identity', identityOnly: true })
  })

  it('keeps the auth protocol surface out of the registry on purpose', () => {
    for (const exemption of HTTP_ROUTE_COVERAGE_EXEMPTIONS) {
      expect(exemption.reason.length, `${exemption.pathTemplate} needs a written reason`).toBeGreaterThan(20)
      for (const method of HTTP_METHODS) {
        expect(getHttpOperationPolicy(method, exemption.pathTemplate), `${method} ${exemption.pathTemplate} must stay unregistered`).toBeUndefined()
      }
    }
  })
})
