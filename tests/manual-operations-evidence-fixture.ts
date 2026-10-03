import { createHash } from 'node:crypto'

export type ManualCaptureIdentity = {
  release_id: string
  release_git_sha: string
  manifest_sha256: string
  image_set_digest: string
}

export type ManualCaptureOptions = {
  manualPublishReportId?: string
  manualPublishState?: string
  manualEvidenceBoundary?: string
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}

export function manualCaptureObservationSha256(name: string, status: number, material: Record<string, unknown>) {
  return createHash('sha256').update(canonical({ name, status, material })).digest('hex')
}

function observation(name: string, status: number, material: Record<string, unknown>) {
  return { name, status, material, observation_sha256: manualCaptureObservationSha256(name, status, material) }
}

export function manualCaptureJournal(candidateIdentity: ManualCaptureIdentity, capturedAt: string, options: ManualCaptureOptions = {}) {
  const manualPublishReportId = options.manualPublishReportId ?? 'manual-report-1'
  const manualPublishState = options.manualPublishState ?? 'manual_publish_reported'
  const manualEvidenceBoundary = options.manualEvidenceBoundary ?? 'manual_unverified'
  return {
    schema_version: 'manual-operations-capture-journal/1',
    captured_at: capturedAt,
    candidate_identity: candidateIdentity,
    observations: [
      observation('release', 200, { ...candidateIdentity, ready: true }),
      observation('target_list', 200, { expected_report_visible: true, visible_report_id: manualPublishReportId, total: 1, returned_count: 1 }),
      observation('target_get', 200, { manual_publish_report_id: manualPublishReportId, state: manualPublishState, evidence_boundary: manualEvidenceBoundary }),
      observation('isolation', 403, { error_envelope: true, code_present: true }),
    ],
  }
}

export function manualCaptureJournalSha256(journal: unknown) {
  return createHash('sha256').update(canonical(journal)).digest('hex')
}
