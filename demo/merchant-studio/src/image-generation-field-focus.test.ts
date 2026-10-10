import { describe, expect, it, vi } from 'vitest'
import { focusImageGenerationField } from './image-generation-field-focus'

describe('image-generation validation field focus', () => {
  it('focuses the requested form control without changing document location', () => {
    const focus = vi.fn()
    const root = { getElementById: vi.fn(() => ({ focus })) }

    expect(focusImageGenerationField('catalog-image-generation-direction', root)).toBe(true)
    expect(root.getElementById).toHaveBeenCalledWith('catalog-image-generation-direction')
    expect(focus).toHaveBeenCalledOnce()
  })

  it('does nothing when the requested field is no longer mounted', () => {
    const root = { getElementById: vi.fn(() => null) }

    expect(focusImageGenerationField('image-generation-count', root)).toBe(false)
    expect(root.getElementById).toHaveBeenCalledWith('image-generation-count')
  })
})
