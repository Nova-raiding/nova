import { describe, expect, it } from 'vitest'
import { reviewProductImages } from './review.js'

describe('product image deterministic checks', () => {
  it('blocks missing and unsafe main images', () => {
    expect(reviewProductImages(undefined)).toEqual([expect.objectContaining({ code: 'MAIN_IMAGE_REQUIRED', severity: 'error' })])
    expect(reviewProductImages(['http://example.com/main.jpg'])).toEqual([expect.objectContaining({ code: 'IMAGE_URL_INVALID', severity: 'error' })])
  })

  it('allows controlled image sources and warns on duplicates', () => {
    expect(reviewProductImages(['https://cdn.example.com/main.jpg', 'https://cdn.example.com/main.jpg'])).toEqual([expect.objectContaining({ code: 'DUPLICATE_IMAGE', severity: 'warning' })])
    expect(reviewProductImages(['fixture://taobao/coat.jpg'])).toEqual([])
  })

  it('rejects low-fi SVG and undersized PNG data URIs', () => {
    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    expect(reviewProductImages(['data:image/svg+xml;base64,PHN2Zy8+'])).toEqual([expect.objectContaining({ code: 'IMAGE_FORMAT_UNSUPPORTED', severity: 'error' })])
    expect(reviewProductImages([tinyPng])).toEqual([expect.objectContaining({ code: 'IMAGE_TOO_SMALL', severity: 'error' })])
  })
})
