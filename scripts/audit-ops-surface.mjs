import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const methods = new Set([...read('packages/contracts/src/mcp.ts').matchAll(/ops\.[A-Za-z0-9_.-]+/g)].map(match => match[0]))

// Feature flags are a separate platform control-plane surface.  The current
// desktop Ops Console deliberately does not expose a feature-flag route: the
// write/emergency operations require an MFA-backed, approval-aware runbook and
// are kept behind the authenticated API/MCP boundary until that UX is shipped.
// Keep these methods explicit here so the audit does not mistake an intentional
// server-only control plane for an accidentally missing UI call.  Adding a UI
// for one of them should remove it from this set in the same change.
//
// `server_only_referenced` below is a code-only signal: a comment that merely
// names one of these methods is not a caller, so naming a method in prose must
// not be mistaken for the missing UI having been built.  It previously listed
// `ops.platform.store.record.create` only because
// `apps/ops-console/src/components/stores/StoreDirectorySection.tsx` explains
// that method in a comment, which invited deleting a deliberate server-only
// entry in favour of a UI that does not exist.
const SERVER_ONLY_METHODS = new Set([
  'ops.feature-flags.list',
  'ops.feature-flag.upsert',
  'ops.feature-flag.emergency.set',
  'ops.feature-flag.events',
  'ops.feature-flag.evaluate',
  // The no-delivery resolution is an audited finance mutation with mandatory
  // provider, usage and settlement proof. It is currently reachable through
  // the authenticated finance MCP surface, not the desktop queue: the queue
  // read model does not expose durable action/evidence facts needed to make a
  // safe one-click decision. Do not infer that the operation is absent; adding
  // a desktop action requires an evidence-backed finance review workflow.
  'ops.marketing.generation.no_delivery.refund',
  // Registering the credential-free manual store record is a narrow
  // platform-operations control plane: it decides which merchant workspace owns
  // which platform store scope, it is the only writer of
  // `platform_accounts.token_state='manually_registered'`, and it can widen
  // what a paid workspace is allowed to do. It therefore stays behind the
  // authenticated API/MCP boundary until the Ops Console ships a reviewed,
  // approval-aware surface for it (the same bar the feature-flag controls are
  // held to). Adding that UI should remove this entry in the same change.
  'ops.platform.store.record.create',
])
// A comment naming an `ops.*` method is not a caller, so references are counted
// from code only: without this, prose about a deliberate server-only control
// plane reads as the frontend already calling it.
//
// A naive `//` / `/*` strip is unsafe on this tree — it has `https://` and
// `manual://` string literals, JSDoc, template literals with `${...}` holes,
// and regex literals such as /\/ops\/?$/u.  This scanner tracks strings,
// template literals and regex literals so it only masks where a comment can
// really start.  Anything it cannot classify is kept verbatim: the failure to
// avoid is deleting real code, which would hide a genuine caller and make the
// audit claim a live UI surface is missing.
const REGEX_PRECEDERS = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '^', '<', '>', '~'])
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await', 'throw'])

// Stop at the closing quote, a newline (unterminated string: give up rather
// than swallow code) or end of file.
function scanString(source, start) {
  const quote = source[start]
  let index = start + 1
  while (index < source.length) {
    const character = source[index]
    if (character === '\\') { index += 2; continue }
    if (character === quote) return index + 1
    if (character === '\n') return index
    index++
  }
  return source.length
}

// Returns `start` when no closing `/` is found, so the caller treats it as an
// ordinary slash (division) instead of a regex.
function scanRegex(source, start) {
  let index = start + 1
  let inClass = false
  while (index < source.length) {
    const character = source[index]
    if (character === '\\') { index += 2; continue }
    if (character === '\n') return start
    if (character === '[') inClass = true
    else if (character === ']') inClass = false
    else if (character === '/' && !inClass) {
      index++
      while (index < source.length && /[a-z]/i.test(source[index])) index++
      return index
    }
    index++
  }
  return start
}

// Masks comments with spaces instead of deleting them, so offsets (and any
// diagnostic line numbers) stay aligned with the original file.
function stripComments(source) {
  let stripped = ''
  let lastCharacter = ''
  let lastWord = ''
  const append = (text) => {
    stripped += text
    for (const character of text) {
      if (/\s/.test(character)) continue
      lastCharacter = character
      lastWord = /[A-Za-z0-9_$]/.test(character) ? lastWord + character : ''
    }
  }
  const contexts = []
  let index = 0
  while (index < source.length) {
    const character = source[index]
    const next = source[index + 1]
    const context = contexts[contexts.length - 1]

    if (context === 'template') {
      if (character === '\\') { append(source.slice(index, index + 2)); index += 2; continue }
      if (character === '`') { append(character); contexts.pop(); index++; continue }
      if (character === '$' && next === '{') { append('${'); contexts.push({ hole: true, depth: 0 }); index += 2; continue }
      append(character); index++; continue
    }
    // Inside a `${...}` hole the text is code again, so nested braces must be
    // balanced before the template resumes.
    if (context && context.hole && character === '{') { context.depth++; append(character); index++; continue }
    if (context && context.hole && character === '}') {
      if (context.depth === 0) { append(character); contexts.pop(); index++; continue }
      context.depth--; append(character); index++; continue
    }

    if (character === '"' || character === "'") {
      const end = scanString(source, index)
      append(source.slice(index, end)); index = end; continue
    }
    if (character === '`') { append(character); contexts.push('template'); index++; continue }
    if (character === '/' && next === '/') {
      const newline = source.indexOf('\n', index)
      const end = newline === -1 ? source.length : newline
      append(' '.repeat(end - index))
      index = end; continue
    }
    if (character === '/' && next === '*') {
      const close = source.indexOf('*/', index + 2)
      const end = close === -1 ? source.length : close + 2
      append(source.slice(index, end).replace(/[^\n]/g, ' '))
      index = end; continue
    }
    if (character === '/' && (REGEX_PRECEDERS.has(lastCharacter) || REGEX_KEYWORDS.has(lastWord))) {
      const end = scanRegex(source, index)
      if (end > index) { append(source.slice(index, end)); index = end; continue }
    }
    append(character); index++
  }
  return stripped
}

const referenced = new Set()
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(file)
    else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      const source = stripComments(fs.readFileSync(file, 'utf8'))
      for (const match of source.matchAll(/ops\.[A-Za-z0-9_.-]+/g)) referenced.add(match[0])
      // Some safety-sensitive operations are deliberately routed through a
      // small, typed decision helper (for example
      // `ops.data.delete.${decision}`). Treat the complete registered family
      // as referenced when the dynamic template is present; otherwise this
      // audit incorrectly reports approve/cancel as missing UI surfaces.
      if (source.includes('ops.data.delete.${')) {
        for (const method of methods) if (method.startsWith('ops.data.delete.')) referenced.add(method)
      }
    }
  }
}
walk(path.join(root, 'apps/ops-console/src'))
const unregisteredServerOnly = [...SERVER_ONLY_METHODS].filter(method => !methods.has(method)).sort()
const serverOnlyReferenced = [...SERVER_ONLY_METHODS].filter(method => referenced.has(method)).sort()
const unreferenced = [...methods].filter(method => !referenced.has(method) && !SERVER_ONLY_METHODS.has(method)).sort()
const indirect = [...methods].filter(method => method.startsWith('ops.data.delete.') && referenced.has('ops.data.delete.')).sort()
const output = {
  generated_at: new Date().toISOString(),
  contract_methods: methods.size,
  frontend_references: [...referenced].filter(method => methods.has(method)).length,
  unreferenced_count: unreferenced.length,
  unreferenced,
  server_only_methods: [...SERVER_ONLY_METHODS].sort(),
  server_only_referenced: serverOnlyReferenced,
  unregistered_server_only: unregisteredServerOnly,
  indirect_candidates: indirect,
}
console.log(JSON.stringify(output, null, 2))
if (unreferenced.length > 0 || unregisteredServerOnly.length > 0) {
  process.exitCode = 1
}
