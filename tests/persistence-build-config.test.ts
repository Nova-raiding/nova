import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

describe('persistence production build boundary', () => {
  it('excludes all test sources while retaining the src root boundary', () => {
    const config = JSON.parse(readFileSync(resolve(root, 'packages/persistence/tsconfig.json'), 'utf8')) as {
      compilerOptions?: { rootDir?: string }
      include?: string[]
      exclude?: string[]
    }

    expect(config.compilerOptions?.rootDir).toBe('src')
    expect(config.include).toEqual(['src/**/*.ts'])
    expect(config.exclude).toContain('src/**/*.test.ts')
    expect(config.exclude).not.toContain('..')
  })
})
