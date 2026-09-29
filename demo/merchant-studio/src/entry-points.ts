export const merchantEntryPoints = ['knowledge', 'products', 'images', 'assets', 'rules', 'trash'] as const

export type MerchantEntryPoint = (typeof merchantEntryPoints)[number]

export function entryPointActionLabel(index: number, label: string, description: string): string {
  return `第 ${index + 1} 步：进入${label}，${description}`
}

export function merchantEntryPointFromQuery(value: string | null): MerchantEntryPoint | undefined {
  if (value === 'rules') return 'products'
  return merchantEntryPoints.includes(value as MerchantEntryPoint) ? value as MerchantEntryPoint : undefined
}

export function assetMatchesEntry(mimeType: string, entry: MerchantEntryPoint): boolean {
  if (entry === 'assets') return true
  // The screenshot-backed knowledge/materials and image-material destinations
  // are two aliases for the same server-backed library. Category and MIME
  // filters are applied by the library controls, so entering either route
  // must not silently hide server assets from the shared listing.
  if (entry === 'images' || entry === 'knowledge') return true
  if (entry === 'rules') return false
  return false
}
