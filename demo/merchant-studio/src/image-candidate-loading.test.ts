import { describe, expect, it } from 'vitest'
import { imageCandidateLoading } from './image-candidate-loading'

describe('image candidate loading strategy', () => {
  it('prioritizes only the first candidate on the first page', () => {
    expect(imageCandidateLoading(1, 0)).toEqual({ loading: 'eager', fetchPriority: 'high' })
    expect(imageCandidateLoading(1, 1)).toEqual({ loading: 'lazy', fetchPriority: 'low' })
  })

  it('keeps every candidate on later pages lazy', () => {
    expect(imageCandidateLoading(2, 0)).toEqual({ loading: 'lazy', fetchPriority: 'low' })
    expect(imageCandidateLoading(3, 12)).toEqual({ loading: 'lazy', fetchPriority: 'low' })
  })
})
