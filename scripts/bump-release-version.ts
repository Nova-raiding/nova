import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The repository uses SemVer for compatibility with npm and the release gates.
 * A release step of 0.01 is therefore represented by one patch increment:
 * 0.1.1 -> 0.1.2. This keeps the externally visible release cadence while
 * preserving the required major.minor.patch contract.
 */
export function nextReleaseVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim())
  if (!match) throw new Error(`invalid release version: ${version}`)
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
}

function replaceJsonVersion(path: string, version: string, key = 'version'): void {
  const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  value[key] = version
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function codexPluginVersion(date: Date): string {
  const stamp = date.toISOString().replace(/[-:TZ.]/gu, '').slice(0, 14)
  return `0.1.0+codex.${stamp}`
}

export function bumpRelease(root = process.cwd(), date = new Date()): { previous: string; next: string; pluginVersion: string } {
  const at = (path: string) => resolve(root, path)
  const versionPath = at('VERSION')
  const previous = readFileSync(versionPath, 'utf8').trim()
  const next = nextReleaseVersion(previous)
  writeFileSync(versionPath, `${next}\n`, 'utf8')

  replaceJsonVersion(at('package.json'), next)
  const lockPath = at('package-lock.json')
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { version?: string; packages?: Record<string, { version?: string }> }
  lock.version = next
  if (lock.packages?.['']) lock.packages[''].version = next
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8')

  const pluginVersion = codexPluginVersion(date)
  for (const path of ['apps/plugin/package.json', 'apps/plugin/.codex-plugin/plugin.json', '.codex-marketplace/plugins/merchant-marketing/package.json', '.codex-marketplace/plugins/merchant-marketing/.codex-plugin/plugin.json']) {
    replaceJsonVersion(at(path), pluginVersion)
  }
  replaceJsonVersion(at('release-metadata.json'), next, 'repositoryVersion')
  replaceJsonVersion(at('release-metadata.json'), pluginVersion, 'pluginVersion')
  const changelogPath = at('CHANGELOG.md')
  const changelog = readFileSync(changelogPath, 'utf8')
  const releaseDate = date.toISOString().slice(0, 10)
  writeFileSync(changelogPath, changelog.replace(/^(# Changelog\s*\n)/u, `$1\n## ${next} - ${releaseDate}\n\n- Release ${next}.\n\n`), 'utf8')
  return { previous, next, pluginVersion }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.url.replace('file://', ''))) {
  if (!process.argv.includes('--apply')) throw new Error('refusing to modify release files without --apply')
  const result = bumpRelease()
  console.log(`release version bumped: ${result.previous} -> ${result.next} (plugin ${result.pluginVersion})`)
}
