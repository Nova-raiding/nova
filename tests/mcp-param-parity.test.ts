import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MCP_METHODS, MCP_METHOD_SCHEMAS, validateMcpRequest } from '../packages/contracts/src/mcp.js'
import { methodScopedParams } from '../apps/api/src/server.js'

/**
 * Handler/contract parameter parity.
 *
 * The defect class this pins: a dispatch head reads `params.<key>` while the
 * method's contract does not declare `<key>`. Because `validateMcpRequest`
 * rejects undeclared keys with 400, such a read either
 *   (a) makes the documented call impossible - the caller follows the handler
 *       (or the shipped client) and every request fails validation, or
 *   (b) is dead drift - the handler silently depends on a sibling method's
 *       schema inside a shared dispatch head, so the contract is only
 *       accidentally right.
 *
 * `campaign.batch.create` + `request_text` was the live instance (the merchant
 * client always sent it, the handler never read it). The structural fix lives
 * in `methodScopedParams` (apps/api/src/server.ts): the dispatch hands each
 * handler only the keys its own contract declares, so a handler cannot observe
 * an undeclared parameter even if the code still mentions it. This test proves
 * the stop, and pins the individual remediations so they cannot silently
 * regress.
 */

const serverSource = readFileSync(new URL('../apps/api/src/server.ts', import.meta.url), 'utf8')
const bridgeSource = readFileSync(new URL('../apps/plugin/mcp/bridge.mjs', import.meta.url), 'utf8')
const merchantApiSource = readFileSync(new URL('../demo/merchant-studio/src/api.ts', import.meta.url), 'utf8')

const declaredKeys = (method: string): Set<string> => new Set(Object.keys(MCP_METHOD_SCHEMAS[method as keyof typeof MCP_METHOD_SCHEMAS].properties))

// Property reads on the local `params` that are not parameter keys.
const NON_PARAMETER_PROPERTIES = new Set([
  'length', 'map', 'filter', 'slice', 'trim', 'includes', 'entries', 'keys', 'values', 'join', 'split',
  'replace', 'startsWith', 'endsWith', 'toLowerCase', 'toUpperCase', 'sort', 'some', 'every', 'find',
  'forEach', 'reduce', 'indexOf', 'has', 'get', 'push', 'concat', 'match', 'charAt', 'toString',
])

type DispatchBlock = { methods: string[]; line: number; body: string; helperCalls: Array<{ camel: string; snake?: string }>; direct: Set<string> }

function stripLiteralsAndComments(line: string): string {
  return line
    .replace(/'(?:[^'\\]|\\.)*'/gu, "''")
    .replace(/"(?:[^"\\]|\\.)*"/gu, '""')
    .replace(/`(?:[^`\\]|\\.)*`/gu, '``')
    .replace(/\/\/.*$/u, '')
    .replace(/\/\*.*?\*\//gu, '')
}

function matchingBrace(source: string, openIndex: number): number {
  let depth = 0
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index]
    if (character === "'" || character === '"' || character === '`') {
      const quote = character
      index += 1
      while (index < source.length && source[index] !== quote) index += source[index] === '\\' ? 2 : 1
      continue
    }
    if (character === '/' && source[index + 1] === '/') { while (index < source.length && source[index] !== '\n') index += 1; continue }
    if (character === '{') depth += 1
    else if (character === '}') { depth -= 1; if (depth === 0) return index }
  }
  throw new Error('unbalanced braces while parsing the dispatch source')
}

/**
 * Group the outer MCP `switch (method)` into dispatch blocks. Consecutive
 * `case` labels share one block, which is exactly how a sibling method's
 * fields leak into another method's handler.
 */
function dispatchBlocks(): DispatchBlock[] {
  const lines = serverSource.split('\n')
  const header = lines.findIndex(line => /^  params = methodScopedParams\(method, params\)$/u.test(line))
  const switchLine = lines.findIndex((line, index) => index > header && /^  switch \(method\) \{$/u.test(line))
  if (header < 0 || switchLine < 0) throw new Error('the MCP dispatch switch (and its parameter scoping) must stay recognizable')
  let switchEnd = lines.length
  {
    let depth = 0
    for (let index = switchLine; index < lines.length; index += 1) {
      for (const character of stripLiteralsAndComments(lines[index]!)) {
        if (character === '{') depth += 1
        else if (character === '}') { depth -= 1; if (depth === 0) { switchEnd = index; break } }
      }
      if (switchEnd !== lines.length) break
    }
  }
  const labels: Array<{ method: string; line: number }> = []
  lines.forEach((line, index) => {
    const match = /^    case '([^']+)':/u.exec(line)
    // Both bounds matter: without the lower one, any 4-space-indented `case`
    // label earlier in the file joins the method list. A switch over item state
    // added elsewhere in server.ts (`case 'approved':`) made this gate report
    // 332 methods and fail for a reason that had nothing to do with parity.
    if (match && index > switchLine && index < switchEnd) labels.push({ method: match[1]!, line: index })
  })
  const groups: Array<{ methods: string[]; start: number; last: number }> = []
  for (const label of labels) {
    const previous = groups[groups.length - 1]
    if (previous && label.line === previous.last + 1) { previous.methods.push(label.method); previous.last = label.line }
    else groups.push({ methods: [label.method], start: label.line, last: label.line })
  }
  return groups.map((group, index) => {
    const end = groups[index + 1]?.start ?? switchEnd
    const body = lines.slice(group.last, end).join('\n')
    const helperCalls: Array<{ camel: string; snake?: string }> = []
    for (const match of body.matchAll(/(\w+)\s*\(\s*params\s*,\s*'([^']+)'(?:\s*,\s*'([^']+)')?/gu)) {
      helperCalls.push({ camel: match[2]!, ...(match[3] ? { snake: match[3] } : {}) })
    }
    const helperKeys = new Set(helperCalls.flatMap(call => [call.camel, ...(call.snake ? [call.snake] : [])]))
    const direct = new Set<string>()
    for (const match of body.matchAll(/\bparams(?:Object)?\.([A-Za-z_][A-Za-z0-9_]*)\b/gu)) if (!NON_PARAMETER_PROPERTIES.has(match[1]!)) direct.add(match[1]!)
    for (const match of body.matchAll(/\bparams(?:Object)?\[\s*'([^']+)'\s*\]/gu)) direct.add(match[1]!)
    for (const key of helperKeys) direct.delete(key)
    return { methods: group.methods, line: group.last + 1, body, helperCalls, direct }
  })
}

const blocks = dispatchBlocks()
const blockFor = (method: string): DispatchBlock | undefined => blocks.find(block => block.methods.includes(method))

function columns(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object literal')
  return value as Record<string, unknown>
}

/** requestMcp call sites that pass a plain object literal, with their keys. */
function merchantClientCallSites(): Array<{ method: string; keys: Set<string> }> {
  const sites: Array<{ method: string; keys: Set<string> }> = []
  const pattern = /requestMcp<[^>]*>\(\s*baseUrl\s*,\s*'([^']+)'\s*,\s*\{/gu
  for (const match of merchantApiSource.matchAll(pattern)) {
    const open = (match.index ?? 0) + match[0].length - 1
    const body = merchantApiSource.slice(open + 1, matchingBrace(merchantApiSource, open))
    const keys = new Set<string>()
    for (const named of body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/gu)) keys.add(named[1]!)
    // Object shorthand (`{ amount_cny: amountCny, channel, ... }`).
    for (const shorthand of body.matchAll(/(?:^|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?=[,}]|$)/gu)) keys.add(shorthand[1]!)
    sites.push({ method: match[1]!, keys })
  }
  return sites
}

describe('MCP handler/contract parameter parity', () => {
  it('covers every method exactly once', () => {
    const covered = blocks.flatMap(block => block.methods)
    expect([...covered].sort()).toEqual([...MCP_METHODS].sort())
    expect(new Set(covered).size).toBe(covered.length)
  })

  it('reads only parameters its own contract declares', () => {
    // Alias helpers (`requiredStringValue(params, 'expectedRevision',
    // 'expected_revision')`) resolve camel-first-then-snake, so a helper call
    // passes when either key is declared; the undeclared branch is then the
    // dead one, and the next test proves the validator rejects it. A bare
    // single-key helper call and every direct `params.<key>` read must be
    // declared outright.
    const failures: string[] = []
    for (const block of blocks) {
      const shared = block.methods.length > 1
      const accepted = new Set(block.methods.flatMap(method => [...declaredKeys(method)]))
      for (const key of block.direct) {
        const offenders = shared ? (accepted.has(key) ? [] : block.methods) : block.methods.filter(method => !declaredKeys(method).has(key))
        if (offenders.length) failures.push(`${block.line}: ${offenders.join(', ')} reads params.${key} that no contract of the dispatch head declares`)
      }
      for (const call of block.helperCalls) {
        const satisfied = (method: string) => {
          const declared = declaredKeys(method)
          return declared.has(call.camel) || (call.snake !== undefined && declared.has(call.snake))
        }
        const offenders = shared ? (block.methods.some(satisfied) ? [] : block.methods) : block.methods.filter(method => !satisfied(method))
        if (offenders.length) failures.push(`${block.line}: ${offenders.join(', ')} reads ${call.camel}${call.snake ? `/${call.snake}` : ''} that no contract of the dispatch head declares`)
      }
    }
    expect(failures).toEqual([])
  })

  it('only lets a handler read parameters the wire validator accepts', () => {
    // Either the key is declared, or `validateMcpRequest` rejects it for that
    // method - in which case the read can never observe a caller value. The
    const failures: string[] = []
    for (const block of blocks) {
      for (const method of block.methods) {
        const declared = declaredKeys(method)
        const readKeys = new Set([...block.direct, ...block.helperCalls.map(call => call.camel)])
        for (const key of readKeys) {
          if (declared.has(key)) continue
          const result = validateMcpRequest({ jsonrpc: '2.0', id: 1, method, params: { [key]: 'parity-probe' } })
          if (result.valid || !result.errors.some(error => error === `params.${key} is not accepted for ${method}`)) {
            failures.push(`${method} reads params.${key}, and the validator does not reject it: ${result.errors.join('; ')}`)
          }
        }
      }
    }
    expect(failures).toEqual([])
  })

  it('has no API-local schema validation bypass', () => {
    expect(serverSource).not.toContain('OPS_MCP_SCHEMA_OVERRIDE_METHODS')
    expect(serverSource).toMatch(/if \(isMcpMethod\(method\)\) \{\n    const validation = validateMcpRequest\(input\)/u)
    for (const method of ['ops.member.upsert', 'ops.member.suspend'] as const) {
      const result = validateMcpRequest({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: { external_subject: 'member_1', expectedRevision: '2', reason: 'contract parity check', ...(method === 'ops.member.upsert' ? { role: 'operator' } : {}) },
      })
      expect(result.valid).toBe(false)
      expect(result.errors).toContain(`params.expectedRevision is not accepted for ${method}`)
    }
  })

  it('scopes the handler view to the active method before dispatch', () => {
    const header = serverSource.split('\n').findIndex(line => /^  params = methodScopedParams\(method, params\)$/u.test(line))
    const switchLine = serverSource.split('\n').findIndex((line, index) => index > header && /^  switch \(method\) \{$/u.test(line))
    expect(header).toBeGreaterThan(-1)
    expect(switchLine).toBe(header + 1)

    // Declared keys survive; a sibling method's fields and dead aliases do not.
    expect(columns(methodScopedParams('ops.audit.export', { workspace_id: 'ws', text: 'q', cursor: 'c', limit: '10' }))).toEqual({ workspace_id: 'ws', text: 'q' })
    expect(columns(methodScopedParams('ops.audit.list', { workspace_id: 'ws', cursor: 'c', limit: '10' }))).toEqual({ workspace_id: 'ws', cursor: 'c', limit: '10' })
    expect(columns(methodScopedParams('billing.reconciliation', { workspace_id: 'ws', from_at: 'a', to_at: 'b' }))).toEqual({ workspace_id: 'ws' })
    expect(columns(methodScopedParams('ops.customer-delivery.checklist.update', { workspace_id: 'ws', delivery_id: 'd', itemsJson: '[]', checklistKey: 'system_integration' }))).toEqual({ workspace_id: 'ws', delivery_id: 'd' })
    expect(columns(methodScopedParams('ops.incident.get', { workspace_id: 'ws', incident_id: 'i', title: 't' }))).toEqual({ workspace_id: 'ws', incident_id: 'i' })
    expect(columns(methodScopedParams('ops.member.upsert', { expected_revision: '2', expectedRevision: '3', whatever: 'x' }))).toEqual({ expected_revision: '2' })
  })
})

describe('audit remediation pins', () => {
  it('campaign.batch.create neither declares, reads, nor sends request_text', () => {
    expect(MCP_METHOD_SCHEMAS['campaign.batch.create'].properties).not.toHaveProperty('request_text')
    expect(blockFor('campaign.batch.create')?.body).not.toMatch(/request_text/u)
    const create = merchantClientCallSites().find(site => site.method === 'campaign.batch.create')
    expect(create?.keys).toBeDefined()
    expect([...create!.keys]).not.toContain('request_text')
    // ... while the method that consumes the text still receives it.
    expect(merchantClientCallSites().find(site => site.method === 'campaign.batch.generate')?.keys).toContain('request_text')
  })

  it('ships a merchant client that only sends declared parameters', () => {
    const failures: string[] = []
    const sites = merchantClientCallSites()
    // The call sites are kept as plain object literals on purpose: a client
    // that hides its parameters behind a variable cannot be checked here.
    expect(sites.map(site => site.method).sort()).toEqual([
      'billing.recharge.create', 'billing.recharge.get', 'billing.transactions',
      'campaign.batch.create', 'campaign.batch.generate', 'catalog.facts.confirm',
      'catalog.image.retry', 'support.customer.replies.list', 'workspace.metrics',
    ])
    for (const site of sites) {
      const declared = declaredKeys(site.method)
      const offContract = [...site.keys].filter(key => !declared.has(key))
      if (offContract.length) failures.push(`${site.method} sends off-contract parameters: ${offContract.join(', ')}`)
      const missing = (MCP_METHOD_SCHEMAS[site.method as keyof typeof MCP_METHOD_SCHEMAS].required ?? []).filter(key => key !== 'workspace_id' && !site.keys.has(key))
      if (missing.length) failures.push(`${site.method} omits required parameters: ${missing.join(', ')}`)
    }
    expect(failures).toEqual([])
  })

  it('keeps the shared ops blocks from reading a sibling schema', () => {
    expect(MCP_METHOD_SCHEMAS['ops.audit.export'].properties).not.toHaveProperty('cursor')
    expect(MCP_METHOD_SCHEMAS['ops.audit.export'].properties).not.toHaveProperty('limit')
    expect(MCP_METHOD_SCHEMAS['billing.reconciliation'].properties).not.toHaveProperty('from_at')
    expect(MCP_METHOD_SCHEMAS['billing.reconciliation'].properties).not.toHaveProperty('to_at')
    for (const method of ['ops.commercial.private-trial.invite.list', 'ops.commercial.private-trial.conversion.create']) {
      expect(MCP_METHOD_SCHEMAS[method as keyof typeof MCP_METHOD_SCHEMAS].properties).not.toHaveProperty('evidence_json')
    }
    // Each shared head below reads a sibling's field today. The scoped view is
    // what makes those reads unobservable for the method whose contract does
    // not declare them; these four expectations are the per-item pins.
    expect(columns(methodScopedParams('ops.audit.export', { workspace_id: 'ws', text: 'q', cursor: 'c', limit: '10' })))
      .toEqual({ workspace_id: 'ws', text: 'q' })
    expect(columns(methodScopedParams('billing.reconciliation', { workspace_id: 'ws', limit: '10', from_at: 'a', to_at: 'b' })))
      .toEqual({ workspace_id: 'ws', limit: '10' })
    expect(columns(methodScopedParams('ops.incident.get', { workspace_id: 'ws', incident_id: 'i', title: 't', summary: 's', severity: 'sev1', limit: '10', cursor: 'c' })))
      .toEqual({ workspace_id: 'ws', incident_id: 'i' })
    // The private-trial block parses evidence_json before its per-method
    // guards; the scoped view is what keeps that parse inert for the two
    // methods whose contract does not declare it.
    expect(columns(methodScopedParams('ops.commercial.private-trial.invite.list', { target_workspace_id: 'ws', evidence_json: '{}', limit: '10' })))
      .toEqual({ target_workspace_id: 'ws', limit: '10' })
  })

  it('declares the audit reasons the handlers actually record', () => {
    expect(MCP_METHOD_SCHEMAS['brand-unit.listing.create'].properties).toHaveProperty('reason')
    expect(blockFor('brand-unit.listing.create')?.body).toMatch(/params\.reason/u)
    expect(MCP_METHOD_SCHEMAS['workspace.commercial.update'].properties).toHaveProperty('reason')
    expect(blockFor('workspace.commercial.update')?.body).toMatch(/params\.reason/u)
  })

  it('declares content.codex.commit expected_version so the metering key is not always latest', () => {
    expect(MCP_METHOD_SCHEMAS['content.codex.commit'].properties).toHaveProperty('expected_version')
    expect(blockFor('content.codex.commit')?.body).toMatch(/params\.expected_version/u)
  })

  it('drops the copy-pasted draft_only read from brand-unit.list', () => {
    expect(MCP_METHOD_SCHEMAS['brand-unit.list'].properties).not.toHaveProperty('draft_only')
    expect(blockFor('brand-unit.list')?.body).not.toMatch(/draft_only/u)
  })

  it('keeps checklist.update on the declared snake_case keys only', () => {
    const block = blockFor('ops.customer-delivery.checklist.update')
    expect(block?.body).not.toMatch(/\bitemsJson\b/u)
    expect(block?.direct.has('items_json')).toBe(true)
    expect(MCP_METHOD_SCHEMAS['ops.customer-delivery.checklist.update'].properties).toHaveProperty('items_json')
  })

  it('validates catalog.image.review against the declared authenticity evidence', () => {
    expect(MCP_METHOD_SCHEMAS['catalog.image.review'].properties).toHaveProperty('authenticity_evidence_json')
    expect(validateMcpRequest({ jsonrpc: '2.0', id: 1, method: 'catalog.image.review', params: { product_id: 'p1', off_contract: 'x' } }).valid).toBe(false)
  })

  it('aligns the asset.upload bridge schema with the wire contract', () => {
    const contract = MCP_METHOD_SCHEMAS['asset.upload']
    expect(contract.required).toEqual(['name', 'mime_type', 'content_base64'])
    expect(contract.properties).not.toHaveProperty('file_path')
    expect(contract.additionalProperties).toBe(false)
    // file_path is bridge-only: the bridge accepts it, inlines the file as
    // content_base64 and drops the path before the API call.
    expect(bridgeSource).toMatch(/'asset\.upload': \{\n[\s\S]*?required: \['name', 'mime_type'\], oneOf: \[\{ required: \['file_path'\] \}, \{ required: \['content_base64'\] \}\]/u)
    expect(bridgeSource).toMatch(/content_base64: bytes\.toString\('base64'\)/u)
    expect(bridgeSource).toMatch(/delete prepared\.file_path/u)
  })
})
