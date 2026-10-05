export interface TriageReport {
  schema_version: string
  candidate: {
    bundle: string | undefined
    git_sha: string
    source_sha256: string
    comparison_manifest_sha256: string
    sync_plan_sha256: string
  }
  counts: { same: number; review_required: number; missing_remote: number }
  review_required: {
    count: number
    top_level_counts: Record<string, number>
    paths: string[]
    source_fetched_count: number
    source_fetched_paths: string[]
    structural_count: number
    structural_match_count: number
    structural_mismatch_count: number
    structural_match_paths: string[]
    structural_mismatch_paths: string[]
    protected_onsite_count: number
    protected_onsite_paths: string[]
    partition_complete: boolean
  }
  missing_remote: {
    count: number
    top_level_counts: Record<string, number>
    paths: string[]
    confirmation: {
      required: boolean
      approved: boolean
      count: number
      paths: string[]
    }
  }
  protected_onsite: {
    required: boolean
    approved: boolean
    count: number
    paths: string[]
    semantic_diff: {
      required: boolean
      approved: boolean
      status: 'not_run' | 'classification_only' | 'completed'
      reason: string
      count: number
      paths: string[]
    }
  }
  three_way_merge_checklist: { local_prepare: string[]; onsite_required: string[]; pass_conditions: string[] }
  decision: 'NO_GO'
  blockers: string[]
}

export function buildTriageReport(bundleInput: string): TriageReport
