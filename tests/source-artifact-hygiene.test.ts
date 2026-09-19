import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const redactedQueryValue = 'REDACTED'
const ossSignedQueryParameter = /(?:^|[?&])(OSSAccessKeyId|Signature|Expires|security-token|x-oss-security-token)=([^&#\s"']*)/gu

function exposedOssSignedQueryParameters(source: string): string[] {
  return [...source.matchAll(ossSignedQueryParameter)]
    .flatMap(match => {
      const name = match[1]
      const value = match[2]
      if (name === undefined || value === undefined || value === redactedQueryValue) return []
      return [name.toLowerCase()]
    })
}

function trackedArtifactFiles(): string[] {
  return execFileSync(
    'git',
    ['grep', '-IlzE', 'OSSAccessKeyId=|[?&]Signature=|[?&]Expires=|[?&](security-token|x-oss-security-token)=', '--', 'artifacts'],
    { cwd: root, maxBuffer: 16 * 1024 * 1024 },
  )
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
}

const generatedEvidencePaths = [
  'artifacts/ops-jit-isolation/example/ui-dist/assets/index.js',
  'screenshots/ops-pages/example.png',
  'dogfood/ops-101-public/example.json',
  'dogfood/merchant-local-20990101/example.json',
  'dogfood/ops-console/screenshots/example.png',
  'dogfood/chatgpt-all-functions/ops-inventory.json',
  'merchant-all-inventory.json',
  'merchant-interactions.json',
  'merchant-inventory.json',
  'ops-all-inventory.json',
  'ops-inventory.json',
  'ops-users-result.json',
  'ops-workspace-visual-inventory.json',
  'output/pdf/example.pdf',
  'tmp/example.py',
] as const

// A path only counts as excluded from source control when it is BOTH matched by
// a .gitignore rule AND absent from the index. `git check-ignore` alone consults
// ignore rules and never the index, so a force-added or historically committed
// artifact would report as "ignored" while still shipping in every clone.
function isIgnored(path: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', path], {
      cwd: root,
      stdio: 'ignore',
    })
    return false
  } catch (error) {
    if ((error as { status?: number }).status !== 1) throw error
  }

  try {
    execFileSync('git', ['check-ignore', '--quiet', '--no-index', path], {
      cwd: root,
      stdio: 'ignore',
    })
    return true
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false
    throw error
  }
}

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
  it('keeps generated runtime evidence out of source control by default', () => {
    expect(
      generatedEvidencePaths.filter(path => !isIgnored(path)),
      'Runtime evidence must be uploaded to the evidence store; force-add only a deliberately reviewed exception.',
    ).toEqual([])
  })

  it('treats a force-added artifact as tracked even when a gitignore rule matches it', () => {
    // The whole point of consulting `git ls-files` before `git check-ignore`:
    // a force-added artifact matches the ignore rule and would report as
    // "ignored" from check-ignore alone, while still shipping in every clone.
    // Every entry in `generatedEvidencePaths` is currently untracked, so
    // without this fixture the tracked-file branch never executes.
    const fixture = `artifacts/hygiene-force-added-${process.pid}-${Date.now()}.json`
    const absolute = join(root, fixture)
    try {
      writeFileSync(absolute, '{}\n')
      expect(isIgnored(fixture), 'the ignore rule must match the fixture path').toBe(true)
      execFileSync('git', ['add', '-f', '--', fixture], { cwd: root, stdio: 'ignore' })
      expect(isIgnored(fixture), 'a staged artifact is not excluded from source control').toBe(false)
    } finally {
      try { execFileSync('git', ['rm', '--cached', '--quiet', '--', fixture], { cwd: root, stdio: 'ignore' }) } catch { /* the fixture was never staged */ }
      rmSync(absolute, { force: true })
    }
  })

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

  it('keeps OSS signed query credentials out of tracked evidence artifacts', () => {
    const exposed = trackedArtifactFiles().flatMap(path => {
      const parameters = exposedOssSignedQueryParameters(readFileSync(join(root, path), 'utf8'))
      return parameters.length === 0 ? [] : [`${path}: ${[...new Set(parameters)].sort().join(', ')}`]
    })

    expect(exposed, 'Commit evidence structure with signed OSS query values replaced by the deterministic REDACTED marker.').toEqual([])
  }, 30_000)

  it('does not flag ordinary public URLs or deterministically redacted evidence URLs', () => {
    expect(exposedOssSignedQueryParameters('https://cdn.example.com/public/image.png?width=1200&format=webp')).toEqual([])
    expect(exposedOssSignedQueryParameters('https://bucket.example.com/object?OSSAccessKeyId=REDACTED&Signature=REDACTED&Expires=REDACTED')).toEqual([])
  })
})
