import { describe, expect, it } from 'vitest'
import { parseCommercialNotificationCursor, parseCommercialNotificationLimit } from './mcp-commercial-handlers.js'

describe('commercial notification list input', () => {
  it('accepts only a complete, bounded cursor shape', () => {
    const cursor = { published_at: '2026-10-05T12:00:00.000Z', event_id: 'publication:event-001' }
    expect(parseCommercialNotificationCursor(Buffer.from(JSON.stringify(cursor)).toString('base64url'))).toEqual(cursor)
    for (const value of [undefined, '', 'not-base64-json', Buffer.from('{}').toString('base64url'), Buffer.from(JSON.stringify({ ...cursor, published_at: 'yesterday' })).toString('base64url'), Buffer.from(JSON.stringify({ ...cursor, event_id: 'bad value' })).toString('base64url')]) {
      if (value === undefined) expect(parseCommercialNotificationCursor(value)).toBeUndefined()
      else expect(() => parseCommercialNotificationCursor(value)).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST', status: 400 }))
    }
  })

  it('rejects malformed and out-of-range page limits as client errors', () => {
    expect(parseCommercialNotificationLimit(undefined)).toBe(50)
    expect(parseCommercialNotificationLimit('100')).toBe(100)
    for (const value of ['0', '101', '1.5', 'NaN', {}, null]) {
      expect(() => parseCommercialNotificationLimit(value)).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST', status: 400 }))
    }
  })
})
