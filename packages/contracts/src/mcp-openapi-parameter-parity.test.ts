import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { MCP_METHODS, MCP_METHOD_SCHEMAS, validateMcpRequest } from './mcp.js'

/**
 * OpenAPI/MCP parameter parity.
 *
 * `McpRequest.params` carries `x-method-schema-refs`: the hand-written OpenAPI
 * schema each production-evidence method advertises to integrators. Nothing
 * compared that map to `MCP_METHOD_SCHEMAS`, the schema the API actually
 * validates with, so the two could disagree indefinitely — and did:
 *
 *   - `ops.canonical.backfill.run` pointed at
 *     `McpCanonicalBackfillRunControlParams`, the schema shared with
 *     pause/resume, which requires and accepts `reason`. The wire contract for
 *     `.run` declares neither, so `validateMcpRequest` answers
 *     `params.reason is not accepted for ops.canonical.backfill.run` (400) for
 *     every caller that follows the published schema. The shipped Ops Console
 *     happens not to send `reason` for the run button, which is why the drift
 *     survived: only an off-console client — exactly the audience the OpenAPI
 *     document exists for — reaches it.
 *   - `ops.marketing.image.archive.audit` advertised a `limit` of 1-999 while
 *     the contract's `pageLimit100` and the handler (which rejects anything
 *     above 100 with INVALID_REQUEST) allow 1-100, so the document's own
 *     description — "the server caps this at 100" — contradicted its pattern.
 *
 * Both directions are checked, because a "the declared params are valid" test
 * only sees one of them:
 *
 *   1. the document must not require a field the wire rejects, nor omit one the
 *      wire requires, or the documented call is impossible;
 *   2. the document must not advertise a wider input than the validator
 *      accepts — the field type and every length/pattern/enum bound — because a
 *      client that validates its own request against the document still gets a
 *      400 from a bound the document never stated.
 *
 * A property written as `$ref` is resolved one level (`platform: { $ref:
 * '#/components/schemas/Platform' }`) so a shared enum is compared by value
 * rather than skipped. This gate reads the published document, not a copy of
 * it: a schema renamed, retargeted or loosened fails here.
 */

const openApiLines = readFileSync(new URL('../../../apps/api/openapi.yaml', import.meta.url), 'utf8').split('\n')

interface FieldSchema {
  readonly type?: string
  readonly enum?: readonly string[]
  readonly pattern?: string
  readonly minLength?: number
  readonly maxLength?: number
}

/**
 * The body of one `components.schemas` entry, at its original indentation: a
 * schema key sits at 6 spaces, a property of it at 8, a continuation deeper.
 */
function schemaBody(name: string): string[] {
  const start = openApiLines.findIndex(line => line === `    ${name}:`)
  if (start < 0) throw new Error(`OpenAPI components.schemas.${name} is missing`)
  const rest = openApiLines.slice(start + 1)
  const end = rest.findIndex(line => /^ {4}[A-Za-z][A-Za-z0-9]*:\s*$/u.test(line))
  return end < 0 ? rest : rest.slice(0, end)
}

/** `x-method-schema-refs`, in document order. */
function declaredMethodSchemaRefs(): Map<string, string> {
  const start = openApiLines.findIndex(line => line === '          x-method-schema-refs:')
  if (start < 0) throw new Error('OpenAPI McpRequest.params.x-method-schema-refs is missing')
  const refs = new Map<string, string>()
  for (const line of openApiLines.slice(start + 1)) {
    const match = /^ {12}([\w.-]+): '#\/components\/schemas\/([A-Za-z0-9_]+)'$/u.exec(line)
    if (!match) break
    if (refs.has(match[1]!)) throw new Error(`duplicate OpenAPI schema ref for ${match[1]}`)
    refs.set(match[1]!, match[2]!)
  }
  if (!refs.size) throw new Error('OpenAPI x-method-schema-refs is empty')
  return refs
}

/** A 6-space schema key's value, with its deeper continuation lines folded in. */
function blockValue(body: readonly string[], key: string): string | undefined {
  const index = body.findIndex(line => new RegExp(`^ {6}${key}:`, 'u').test(line))
  if (index < 0) return undefined
  let value = body[index]!.slice(body[index]!.indexOf(':') + 1).trim()
  let cursor = index
  while (cursor + 1 < body.length && !/^ {6}[A-Za-z]/u.test(body[cursor + 1]!)) {
    cursor += 1
    value += ` ${body[cursor]!.trim()}`
  }
  return value
}

function inlineArray(value: string | undefined, label: string): string[] {
  if (value === undefined) return []
  const open = value.indexOf('[')
  const close = value.lastIndexOf(']')
  if (open < 0 || close < open) throw new Error(`${label} must be an inline array, got: ${value}`)
  return value.slice(open + 1, close).split(',').map(entry => entry.trim().replace(/^['"]|['"]$/gu, '')).filter(Boolean)
}

/** Property name -> the text of its schema, continuation lines folded in. */
function bodyProperties(body: readonly string[]): Map<string, string> {
  const start = body.findIndex(line => /^ {6}properties:\s*$/u.test(line))
  if (start < 0) throw new Error('schema body has no properties block')
  const properties = new Map<string, string>()
  let current: string | undefined
  for (const line of body.slice(start + 1)) {
    if (/^ {6}[A-Za-z]/u.test(line)) break // the next schema key ends the block
    const match = /^ {8}([a-z_][a-z0-9_]*):(.*)$/u.exec(line)
    if (match) {
      current = match[1]!
      properties.set(current, match[2]!.trim())
      continue
    }
    if (current !== undefined) properties.set(current, `${properties.get(current)!} ${line.trim()}`.trim())
  }
  return properties
}

/** Fold a one-level `$ref` into the referenced schema's own constraint keys. */
function resolveRef(text: string): string {
  const ref = /\$ref:\s*'#\/components\/schemas\/([A-Za-z0-9_]+)'/u.exec(text)
  if (!ref) return text
  const target = schemaBody(ref[1]!)
  return ['type', 'enum', 'pattern', 'minLength', 'maxLength']
    .flatMap(key => {
      const value = blockValue(target, key)
      return value === undefined ? [] : [`${key}: ${value}`]
    })
    .join(', ')
}

/** The constraints the document states for one property, normalized. */
function documentConstraints(text: string): string[] {
  const resolved = resolveRef(text)
  const constraints: string[] = []
  const type = /\btype:\s*([A-Za-z]+)/u.exec(resolved)?.[1]
  const list = /(?:^|[\s,{])enum:\s*\[([^\]]*)\]/u.exec(resolved)?.[1]
  const pattern = /\bpattern:\s*'([^']*)'/u.exec(resolved)?.[1]
  const minLength = /\bminLength:\s*(\d+)/u.exec(resolved)?.[1]
  const maxLength = /\bmaxLength:\s*(\d+)/u.exec(resolved)?.[1]
  if (type !== undefined) constraints.push(`type=${type}`)
  if (list !== undefined) constraints.push(`enum=[${list.split(',').map(entry => entry.trim().replace(/^['"]|['"]$/gu, '')).join(',')}]`)
  if (pattern !== undefined) constraints.push(`pattern=${pattern}`)
  if (minLength !== undefined) constraints.push(`minLength=${minLength}`)
  if (maxLength !== undefined) constraints.push(`maxLength=${maxLength}`)
  return constraints
}

/** The same constraints read off the schema `validateMcpRequest` enforces. */
function contractConstraints(field: FieldSchema): string[] {
  const constraints: string[] = []
  if (field.type !== undefined) constraints.push(`type=${field.type}`)
  if (field.enum !== undefined) constraints.push(`enum=[${field.enum.join(',')}]`)
  if (field.pattern !== undefined) constraints.push(`pattern=${field.pattern}`)
  if (field.minLength !== undefined) constraints.push(`minLength=${field.minLength}`)
  if (field.maxLength !== undefined) constraints.push(`maxLength=${field.maxLength}`)
  return constraints
}

function compareMethod(method: string, schemaName: string): string[] {
  const schema = MCP_METHOD_SCHEMAS[method as keyof typeof MCP_METHOD_SCHEMAS]
  if (!schema) return [`x-method-schema-refs names an unregistered MCP method: ${method}`]
  const body = schemaBody(schemaName)
  const failures: string[] = []
  const documented = inlineArray(blockValue(body, 'required'), `${schemaName}.required`).sort()
  const enforced = [...(schema.required ?? [])].sort()
  if (documented.join(',') !== enforced.join(',')) {
    failures.push(`${method}: OpenAPI requires [${documented.join(', ')}] but the wire contract requires [${enforced.join(', ')}]`)
  }
  const properties = bodyProperties(body)
  for (const [name, text] of properties) {
    const field = schema.properties[name] as FieldSchema | undefined
    if (!field) {
      failures.push(`${method}: OpenAPI declares params.${name}, which the wire contract rejects`)
      continue
    }
    const missing = contractConstraints(field).filter(constraint => !documentConstraints(text).includes(constraint))
    if (missing.length) {
      failures.push(`${method}: params.${name} is documented as ${documentConstraints(text).join(', ') || '(unconstrained)'} but the wire contract enforces ${missing.join(', ')}`)
    }
  }
  for (const name of Object.keys(schema.properties)) {
    if (!properties.has(name)) failures.push(`${method}: the wire contract declares params.${name}, which OpenAPI omits`)
  }
  return failures
}

describe('OpenAPI/MCP parameter parity', () => {
  const refs = declaredMethodSchemaRefs()

  it('derives a non-trivial ref inventory instead of passing vacuously', () => {
    expect(refs.size).toBeGreaterThan(20)
    expect(refs.get('platform.mapping.preflight')).toBe('McpPlatformMappingPreflightParams')
    expect(refs.get('ops.customer-delivery.assets.upload')).toBe('McpCustomerDeliveryAssetUploadParams')
    expect([...refs.keys()].every(method => MCP_METHODS.includes(method as typeof MCP_METHODS[number]))).toBe(true)
    // Every method the document points at a named schema must resolve it.
    for (const [method, name] of refs) expect(() => schemaBody(name), `${method} -> ${name}`).not.toThrow()
  })

  it('advertises exactly the schema the wire validator enforces for every ref', () => {
    expect([...refs].flatMap(([method, schemaName]) => compareMethod(method, schemaName))).toEqual([])
  })

  it('pins the backfill run/pause split that this gate was written for', () => {
    // `.run` borrowed the pause/resume schema, so the document required and
    // accepted `reason` while `validateMcpRequest` refused it.
    const run = MCP_METHOD_SCHEMAS['ops.canonical.backfill.run']
    expect(Object.keys(run.properties)).not.toContain('reason')
    expect([...(run.required ?? [])].sort()).toEqual(['expected_revision', 'run_id'])
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 1, method: 'ops.canonical.backfill.run', params: { run_id: 'run_1', expected_revision: '1', reason: 'manual run' } }))
      .toMatchObject({ valid: false, errors: ['params.reason is not accepted for ops.canonical.backfill.run'] })
    expect(refs.get('ops.canonical.backfill.run')).toBe('McpCanonicalBackfillRunExecuteParams')
    expect(refs.get('ops.canonical.backfill.pause')).toBe('McpCanonicalBackfillRunControlParams')
    expect(refs.get('ops.canonical.backfill.resume')).toBe('McpCanonicalBackfillRunControlParams')
    // The pause/resume half of the family still requires and accepts `reason`,
    // so the split must not be "delete reason from the shared control schema".
    expect(inlineArray(blockValue(schemaBody('McpCanonicalBackfillRunControlParams'), 'required'), 'required').sort())
      .toEqual(['expected_revision', 'reason', 'run_id'])
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 1, method: 'ops.canonical.backfill.pause', params: { run_id: 'run_1', expected_revision: '1', reason: 'pause it' } }).valid).toBe(true)
  })

  it('pins the archive-audit limit bound the document used to overstate', () => {
    const schema = MCP_METHOD_SCHEMAS['ops.marketing.image.archive.audit']
    expect(schema.properties.limit).toMatchObject({ pattern: '^(?:[1-9]|[1-9][0-9]|100)$', maxLength: 3 })
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 1, method: 'ops.marketing.image.archive.audit', params: { limit: '500' } }).valid).toBe(false)
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 1, method: 'ops.marketing.image.archive.audit', params: { limit: '100' } }).valid).toBe(true)
  })
})
