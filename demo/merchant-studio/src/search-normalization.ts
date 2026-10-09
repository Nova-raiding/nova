export function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase()
}

export function matchesSearchText(haystack: string, query: string): boolean {
  return normalizeSearchText(haystack).includes(normalizeSearchText(query))
}
