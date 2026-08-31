export const merchantEntryPoints = ['knowledge', 'products', 'images', 'assets'] as const

export type MerchantEntryPoint = (typeof merchantEntryPoints)[number]

export function entryPointActionLabel(index: number, label: string, description: string): string {
  return `第 ${index + 1} 步：进入${label}，${description}`
}

export function merchantEntryPointFromQuery(value: string | null): MerchantEntryPoint | undefined {
  return merchantEntryPoints.includes(value as MerchantEntryPoint) ? value as MerchantEntryPoint : undefined
}

export function assetMatchesEntry(mimeType: string, entry: MerchantEntryPoint): boolean {
  if (entry === 'assets') return true
  if (entry === 'images') return mimeType.startsWith('image/')
  if (entry === 'knowledge') return !mimeType.startsWith('image/')
  return false
}
