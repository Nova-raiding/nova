export interface CreativePointRequestOwnership {
  reservationId: string
  requestOwnsReservation: boolean
}

/** A replay returns the shared action hold, but does not own its cleanup. */
export function creativePointRequestOwnership(mutation: { value: { id: string }; replayed: boolean }): CreativePointRequestOwnership {
  return { reservationId: mutation.value.id, requestOwnsReservation: !mutation.replayed }
}

/** Only the request that created this exact still-active hold may release it. */
export function mayReleaseCreativePointReservation(
  owner: CreativePointRequestOwnership | null | undefined,
  current: { id: string; status: string } | null | undefined,
): boolean {
  return Boolean(owner?.requestOwnsReservation && current?.id === owner.reservationId && current.status === 'active')
}
