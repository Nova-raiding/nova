export type ImageGenerationField = 'direction' | 'count'

export interface FocusableFieldDocument {
  getElementById(id: string): { focus(options?: FocusOptions): void } | null
}

/** Focus the form field named by an image-generation validation error. */
export function focusImageGenerationField(
  id: string,
  root: FocusableFieldDocument = document,
): boolean {
  const field = root.getElementById(id)
  if (!field) return false
  field.focus()
  return true
}
