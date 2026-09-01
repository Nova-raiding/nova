import { describe, expect, it } from 'vitest'
import { getImageCandidatePage, IMAGE_CANDIDATE_PAGE_SIZE } from './image-candidate-pagination'

describe('image candidate pagination', () => {
  it('keeps the default gallery bounded at 50 candidates', () => {
    const result = getImageCandidatePage(Array.from({ length: 51 }, (_, index) => `candidate-${index}`), 1)
    expect(result.items).toHaveLength(IMAGE_CANDIDATE_PAGE_SIZE)
    expect(result.pageCount).toBe(2)
    expect(result.items[0]).toBe('candidate-0')
    expect(result.items.at(-1)).toBe('candidate-49')
  })

  it('clamps stale page state after a refresh reduces the result set', () => {
    const result = getImageCandidatePage(['candidate-0', 'candidate-1'], 4)
    expect(result.page).toBe(1)
    expect(result.items).toEqual(['candidate-0', 'candidate-1'])
  })

  it('returns the correct slice while preserving order and total count', () => {
    const result = getImageCandidatePage(['a', 'b', 'c', 'd', 'e'], 2, 2)
    expect(result).toEqual({ items: ['c', 'd'], page: 2, pageCount: 3, total: 5 })
  })
})
