import { readFileSync } from 'node:fs'
import {
  PLATFORM_CAPABILITY_CONTRACT_CAPABILITIES,
  PLATFORM_CAPABILITY_CONTRACT_PLATFORMS,
  PLATFORM_CAPABILITY_EVIDENCE_STATES,
  validatePlatformCapabilityEvidence,
} from '../packages/connectors/src/platform-preflight.js'

export const REQUIRED_PLATFORMS = PLATFORM_CAPABILITY_CONTRACT_PLATFORMS
export const REQUIRED_CAPABILITIES = PLATFORM_CAPABILITY_CONTRACT_CAPABILITIES
export const EVIDENCE_STATES = PLATFORM_CAPABILITY_EVIDENCE_STATES

export function validateCapabilityEvidence(document: unknown, options: { requireCanary?: boolean; expectedReleaseId?: string } = {}): string[] {
  const errors = validatePlatformCapabilityEvidence(document, options)
  return errors.some(error => error.includes('secret-like field is not allowed'))
    ? [...errors, 'evidence document must not contain secret-like keys or values']
    : errors
}

function main() {
  const args = process.argv.slice(2)
  const fileIndex = args.indexOf('--file')
  const path = (fileIndex >= 0 ? args[fileIndex + 1] : undefined) ?? 'docs/platform-capability-evidence.example.json'
  const releaseIndex = args.indexOf('--release-id')
  const expectedReleaseId = releaseIndex >= 0 ? args[releaseIndex + 1] : undefined
  let document: unknown
  try { document = JSON.parse(readFileSync(path, 'utf8')) } catch (error) { console.error(`unable to read JSON evidence: ${error instanceof Error ? error.message : String(error)}`); process.exit(1) }
  const errors = validateCapabilityEvidence(document, { requireCanary: args.includes('--require-canary'), expectedReleaseId })
  if (errors.length) { console.error(errors.map(error => `- ${error}`).join('\n')); process.exit(1) }
  console.log(`capability evidence gate passed: ${path}${args.includes('--require-canary') ? ' (production_canary)' : ''}`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
