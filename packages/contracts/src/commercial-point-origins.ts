export interface OnboardingGiftBatchView {
  schedule_id: string
  sequence: number
  points: number
  due_at: string | null
  expires_at: string | null
  schedule_status: string
  grant_id: string | null
  granted_at: string | null
  dispatch_id: string | null
  dispatched_at: string | null
  expiration_id: string | null
  expired_at: string | null
  expired_by_time: boolean
  blockers: readonly string[]
}
export interface OnboardingGiftPlanView {
  source_order_id: string
  source_order_status: string
  order_snapshot_id: string
  sku_code: string
  sku_version_id: string
  source_checksum: string
  policy_ref: unknown
  grant_count: number
  points_per_grant: number
  total_points: number
  batches: readonly OnboardingGiftBatchView[]
}
export interface OnboardingGiftsView {
  status: 'available' | 'unknown'
  plans: readonly OnboardingGiftPlanView[] | null
  blockers: readonly string[]
}
export interface CommercialPointOriginView {
  status: 'known' | 'unknown'
  kind: 'onboarding_gift' | 'subscription_points' | 'point_pack' | 'other' | null
  source_order_id: string | null
  sku_version_id: string | null
  schedule_id: string | null
  sequence: number | null
  grant_id: string | null
}
export interface CommercialPointOriginReadPort {
  readOnboardingGifts(workspaceId: string): Promise<OnboardingGiftsView>
  readStatementOrigins(workspaceId: string, entryIds: readonly string[]): Promise<Readonly<Record<string, CommercialPointOriginView>>>
}
export interface FrozenOnboardingGiftPolicyView {
  grant_count: number
  points_per_grant: number
  cadence: string
  starts_at: string
  grant_expires_at_rule: string
}
