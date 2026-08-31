import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

function sourceArtifacts(directory: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      found.push(...sourceArtifacts(path))
      continue
    }
    if (/\.(?:js|js\.map|d\.ts|d\.ts\.map)$/u.test(entry.name)) {
      found.push(relative(root, path))
    }
  }
  return found
}

describe('source artifact hygiene', () => {
  it('keeps emitted JavaScript and declarations out of package source trees', () => {
    const artifacts = readdirSync(join(root, 'packages'), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .flatMap(entry => {
        const source = join(root, 'packages', entry.name, 'src')
        try {
          return sourceArtifacts(source)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
          throw error
        }
      })

    expect(artifacts, 'Build outputs beside TypeScript can shadow current source under NodeNext/Vitest; emit only to dist/.').toEqual([])
  })
})
