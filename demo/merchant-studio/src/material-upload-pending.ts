export type PendingMaterialFile = { id: string; file: File }

export const MAX_PENDING_MATERIAL_FILES = 50

export const uploadDialogCloseAllowed = (uploading: boolean): boolean => !uploading

export function revokeObsoletePreviewUrls(
  previous: Set<string>,
  current: Set<string>,
  revoke: (url: string) => void = (url) => URL.revokeObjectURL(url),
): Set<string> {
  for (const url of previous) if (!current.has(url)) revoke(url)
  return current
}

export function releasePreviewUrls(
  urls: Set<string>,
  revoke: (url: string) => void = (url) => URL.revokeObjectURL(url),
): void {
  for (const url of urls) revoke(url)
}

export function appendPendingMaterialFiles(
  current: PendingMaterialFile[],
  incoming: File[],
  createId: () => string = () => crypto.randomUUID(),
): { items: PendingMaterialFile[]; notAdded: number } {
  const overLimit = current.length + incoming.length > MAX_PENDING_MATERIAL_FILES
  if (overLimit) return { items: current, notAdded: incoming.length }
  return {
    items: [...current, ...incoming.map((file) => ({ id: createId(), file }))],
    notAdded: 0,
  }
}

export function removePendingMaterialFiles(
  current: PendingMaterialFile[],
  ids: string[],
): PendingMaterialFile[] {
  const selected = new Set(ids)
  return current.filter((item) => !selected.has(item.id))
}

export function acceptedPendingMaterialIds(
  pending: PendingMaterialFile[],
  acceptedFiles: File[],
): Set<string> {
  const accepted = new Set(acceptedFiles)
  return new Set(pending.filter((item) => accepted.has(item.file)).map((item) => item.id))
}
