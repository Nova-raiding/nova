import { describe, expect, it } from 'vitest'
import { parseRequestedImageSize } from './image-archive-helpers.js'

describe('image archive requested size contract', () => {
  it('parses one strict positive width and height pair', () => {
    expect(parseRequestedImageSize('1024x4096')).toEqual({ width: 1024, height: 4096 })
    expect(parseRequestedImageSize(undefined)).toBeUndefined()
  })

  it('rejects extra segments and non-positive or unsafe dimensions', () => {
    for (const value of ['1024x4096xjunk', '1024', '0x4096', '-1x4096', '1x1.5', '999999999999999999x2']) {
      expect(() => parseRequestedImageSize(value)).toThrow('图片请求尺寸')
    }
  })
})
