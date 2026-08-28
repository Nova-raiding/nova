import { readFileSync } from 'node:fs'

export const REQUIRED_RELAY_MODALITIES = ['text', 'image', 'image_edit', 'ocr', 'video'] as const
type Modality = typeof REQUIRED_RELAY_MODALITIES[number]
type RelayResult = { modality?: Modality; state?: string; endpoint?: string; model?: string; providerRequestId?: string; usageObserved?: boolean; costObserved?: boolean }
type RelayEvidence = { schema_version?: string; release_id?: string; generated_at?: string; relay?: string; results?: RelayResult[] }

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const isIsoInstant = (value: unknown): value is string => nonEmpty(value) && !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value)
const relayOrigin = (value: string): string | undefined => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.origin : undefined
  } catch { return undefined }
}

export function validateModelRelayEvidence(document: unknown, options: { expectedReleaseId?: string; expectedRelay?: string } = {}): string[] {
  const errors: string[] = []
  if (!document || typeof document !== 'object' || Array.isArray(document)) return ['document must be a JSON object']
  const value = document as RelayEvidence
  if (value.schema_version !== '1') errors.push('schema_version must be 1')
  if (!nonEmpty(value.release_id)) errors.push('release_id is required')
  if (options.expectedReleaseId && value.release_id !== options.expectedReleaseId) errors.push(`release_id must match ${options.expectedReleaseId}`)
  if (!isIsoInstant(value.generated_at)) errors.push('generated_at must be an ISO instant')
  if (!nonEmpty(value.relay)) errors.push('relay is required')
  else try {
    const relay = new URL(value.relay)
    if (relay.protocol !== 'https:' || relay.username || relay.password || relay.pathname !== '/' || relay.search || relay.hash) errors.push('relay must be a plain HTTPS origin')
    if (options.expectedRelay && relay.origin !== relayOrigin(options.expectedRelay)) errors.push('relay must match the rendered production model_relay_base_url origin')
  } catch { errors.push('relay must be a valid HTTPS URL') }
  if (!Array.isArray(value.results)) return [...errors, 'results is required']
  const byModality = new Map<string, RelayResult>()
  for (const result of value.results) {
    if (!result || typeof result !== 'object' || !nonEmpty(result.modality)) { errors.push('each results item must have a modality'); continue }
    if (byModality.has(result.modality)) errors.push(`duplicate modality: ${result.modality}`)
    byModality.set(result.modality, result)
  }
  for (const modality of REQUIRED_RELAY_MODALITIES) {
    const result = byModality.get(modality)
    if (!result) { errors.push(`${modality} result is required`); continue }
    if (result.state !== 'ready') errors.push(`${modality} state must be ready`)
    if (!nonEmpty(result.endpoint)) errors.push(`${modality}.endpoint is required`)
    if (!nonEmpty(result.model)) errors.push(`${modality}.model is required`)
    if (!nonEmpty(result.providerRequestId)) errors.push(`${modality}.providerRequestId is required`)
    if (result.usageObserved !== true) errors.push(`${modality}.usageObserved must be true`)
    if (result.costObserved !== true) errors.push(`${modality}.costObserved must be true`)
  }
  return errors
}

function main() {
  const args = process.argv.slice(2)
  const fileIndex = args.indexOf('--file')
  const path = fileIndex >= 0 ? args[fileIndex + 1] : undefined
  const releaseIndex = args.indexOf('--release-id')
  const expectedReleaseId = releaseIndex >= 0 ? args[releaseIndex + 1] : undefined
  const relayIndex = args.indexOf('--expected-relay')
  const expectedRelay = relayIndex >= 0 ? args[relayIndex + 1] : undefined
  if (!path) { console.error('--file is required'); process.exit(2) }
  let document: unknown
  try { document = JSON.parse(readFileSync(path, 'utf8')) } catch (error) { console.error(`unable to read JSON relay evidence: ${error instanceof Error ? error.message : String(error)}`); process.exit(1) }
  const errors = validateModelRelayEvidence(document, { expectedReleaseId, expectedRelay })
  if (errors.length) { console.error(errors.map(error => `- ${error}`).join('\n')); process.exit(1) }
  console.log(`model relay evidence gate passed: ${path}`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
