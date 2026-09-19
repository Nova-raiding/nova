import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * `doc/todo/release/delivery-input-checklist.md` is the operator-facing form of
 * `infra/config/production.blocked.example.yaml`: the template lists the keys a
 * deployment must supply, and the checklist says who supplies each one, where it
 * goes, and what breaks without it.
 *
 * The checklist is only useful if it names every key. A grouped reference such
 * as "`jd_*` / `taobao_tmall_*`" reads fine but cannot be ticked off item by
 * item, and a section that silently stops covering a newly required key is the
 * same "document promises more than the code provides" failure this repository
 * has had to correct repeatedly. This pins the two together mechanically.
 */
const template = readFileSync('infra/config/production.blocked.example.yaml', 'utf8')
const checklist = readFileSync('doc/todo/release/delivery-input-checklist.md', 'utf8')

/** Keys the blocked template declares as required production inputs. */
const requiredKeys = template
  .split(/\r?\n/)
  .map(line => /^([a-z0-9_]+):\s*null$/u.exec(line.trim())?.[1])
  .filter((key): key is string => key !== undefined)

describe('delivery input checklist', () => {
  it('derives a non-trivial required key set from the blocked template', () => {
    // Guards the parser itself: if the template's shape changes, this fails
    // loudly instead of the coverage assertion below passing over an empty set.
    expect(requiredKeys.length).toBeGreaterThan(50)
    expect(new Set(requiredKeys).size).toBe(requiredKeys.length)
  })

  it('names every required production input verbatim', () => {
    const missing = requiredKeys.filter(key => !checklist.includes(key))
    expect(missing, `delivery-input-checklist.md does not name: ${missing.join(', ')}`).toEqual([])
  })

  it('points an operator at the gate that produces the key list', () => {
    // The checklist is derived, not authoritative. If it stops saying where the
    // list comes from, the two drift the first time the template changes.
    expect(checklist).toContain('infra/config/production.blocked.example.yaml')
  })
})
