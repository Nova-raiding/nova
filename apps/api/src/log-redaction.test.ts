import { describe, expect, it } from 'vitest'
import { redactInlineCredentials } from './server.js'

/**
 * Table-driven coverage for the free-text credential scrubber used on the
 * unhandled-error log path.
 *
 * The first version of this helper shipped with **no test at all**, and the
 * cases below are exactly the ones it got wrong: the empty-username Redis form
 * (`redis://:password@host`, which is the common shape of `REDIS_URL`), a
 * password containing `/` or `@`, and a quoted bearer token. Every one of them
 * passed through unredacted.
 *
 * A `null` expectation means "must not appear in the output".
 */
const MUST_BE_REDACTED: Array<{ input: string; leaks: string[] }> = [
  { input: 'postgres://user:s3cr3t@10.0.0.1:5432/merchant', leaks: ['s3cr3t'] },
  { input: 'mongodb+srv://admin:pa55w0rd@cluster0.example/db', leaks: ['pa55w0rd'] },
  { input: 'amqp://guest:guestpw@rabbit:5672', leaks: ['guestpw'] },
  // Empty username — the standard Redis form, and the shape `REDIS_URL` takes.
  { input: 'redis://:pwonly@h:6379', leaks: ['pwonly'] },
  { input: 'redis://:p@ssword@h', leaks: ['ssword'] },
  // A base64 secret routinely contains `/`, and the old pattern stopped at it.
  { input: 'postgres://u:ab/cdef+gh=@h/db', leaks: ['ab/cdef+gh='] },
  // A password containing `@` used to leak everything after the first one.
  { input: 'postgres://u:p@ss@h/db', leaks: ['ss'] },
  { input: 'Authorization: Bearer "eyJhbGciOiJIUzI1NiJ9.payload.sig"', leaks: ['eyJhbGciOiJIUzI1NiJ9'] },
  { input: 'authorization=Bearer id:secretvalue1234', leaks: ['id:secretvalue1234'] },
  { input: 'Bearer tok,with,commas1234567', leaks: ['tok,with,commas1234567'] },
]

describe('redactInlineCredentials', () => {
  it.each(MUST_BE_REDACTED)('scrubs credentials from $input', ({ input, leaks }) => {
    const output = redactInlineCredentials(input)
    for (const leak of leaks) expect(output, `leaked "${leak}" from: ${output}`).not.toContain(leak)
    expect(output).toContain('[REDACTED]')
  })

  it('keeps the parts of a message that are not credentials', () => {
    // Over-redacting the userinfo segment is acceptable; losing the host, the
    // path, or the surrounding diagnostic text is not.
    const output = redactInlineCredentials('Failed to connect: postgres://u:pw@db.internal:5432/merchant (timeout after 5000ms)')
    expect(output).toContain('Failed to connect:')
    expect(output).toContain('db.internal:5432/merchant')
    expect(output).toContain('timeout after 5000ms')
  })

  it('does not touch a URL with no credentials in it', () => {
    expect(redactInlineCredentials('see https://example.com/a/b?x=1')).toBe('see https://example.com/a/b?x=1')
  })

  it('does not swallow across newlines in a stack trace', () => {
    const output = redactInlineCredentials('Error: boom\n    at connect (postgres://u:pw@h/db:1:1)\n    at main (app.js:2:1)')
    expect(output).not.toContain('pw@')
    expect(output).toContain('at main (app.js:2:1)')
  })

  it('leaves short bearers alone, matching the documented 12-character floor', () => {
    expect(redactInlineCredentials('Bearer abc')).toBe('Bearer abc')
  })
})
