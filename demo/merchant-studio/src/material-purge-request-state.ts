export type MaterialPurgeRequestOutcome = {
  selectedIds: string[]
  closeDialog: boolean
  clearConfirmation: boolean
  clearReason: boolean
}

export function materialPurgeRequestOutcome(
  selectedIds: string[],
  acceptedIds: string[],
): MaterialPurgeRequestOutcome {
  const accepted = new Set(acceptedIds)
  const remainingIds = selectedIds.filter((id) => !accepted.has(id))
  const complete = remainingIds.length === 0
  return {
    selectedIds: remainingIds,
    closeDialog: complete,
    clearConfirmation: complete,
    clearReason: complete,
  }
}
