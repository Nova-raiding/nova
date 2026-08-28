import type { PlatformProfile, PlatformWriteDraft, RawProduct, ValidationFinding } from '../types.js'

export function validateProfileWrite(profile: PlatformProfile, input: PlatformWriteDraft): ValidationFinding[] {
  const findings: ValidationFinding[] = []
  for (const field of Object.keys(input.fields)) {
    if (!profile.writableFields.includes(field)) {
      findings.push({ field, code: 'NOT_ALLOWED', message: `${field} is not writable for ${profile.platform}`, severity: 'error' })
    }
  }
  for (const field of profile.requiredFields) {
    if (input.fields[field] === undefined || input.fields[field] === null || input.fields[field] === '') {
      findings.push({ field, code: 'REQUIRED', message: `${field} is required`, severity: 'error' })
    }
  }
  if (typeof input.fields.title !== 'undefined' && typeof input.fields.title !== 'string') {
    findings.push({ field: 'title', code: 'INVALID_TYPE', message: 'title must be a string', severity: 'error' })
  }
  if (typeof input.fields.price !== 'undefined' && (typeof input.fields.price !== 'number' || input.fields.price < 0)) {
    findings.push({ field: 'price', code: 'INVALID_VALUE', message: 'price must be a non-negative number', severity: 'error' })
  }
  return findings
}

export function mapFixture(platform: PlatformProfile['platform'], raw: RawProduct, mappingVersion: string) {
  const rawStatus = raw.listingStatus ?? Object.entries(raw.platformFields).find(([key]) => /status|state|sale/iu.test(key))?.[1]
  const normalizedStatus = typeof rawStatus === 'string' ? (/on.?sale|onsale|selling|published|上架/iu.test(rawStatus) ? 'on_sale' : /off.?sale|offsale|下架|deleted/iu.test(rawStatus) ? 'off_sale' : /draft/iu.test(rawStatus) ? 'draft' : 'unknown') : 'unknown'
  const rawPlatformFields = Object.fromEntries(Object.entries(raw.platformFields).slice(0, 50).map(([key, value]) => [key, typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null ? value : '[structured]']))
  return {
    platform,
    remoteId: raw.remoteId,
    title: raw.title,
    description: raw.description,
    price: raw.price,
    stock: raw.stock,
    sku: raw.sku,
    images: raw.images,
    category: raw.category,
    facts: { ...raw.attributes, stock: raw.stock, price: raw.price },
    mappingVersion,
    source: 'fixture' as const,
    listingStatus: normalizedStatus as 'on_sale' | 'off_sale' | 'draft' | 'unknown',
    platformUpdatedAt: raw.observedAt,
    rawPlatformFields,
  }
}
