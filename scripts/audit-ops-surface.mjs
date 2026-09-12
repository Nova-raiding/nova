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
const SERVER_ONLY_METHODS = new Set([
  'ops.feature-flags.list',
  'ops.feature-flag.upsert',
  'ops.feature-flag.emergency.set',
  'ops.feature-flag.events',
  'ops.feature-flag.evaluate',
])
const referenced = new Set()
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(file)
    else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      const source = fs.readFileSync(file, 'utf8')
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
