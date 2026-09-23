import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'

/** Resolve the Git SHA from this checkout or a Git-less ECS staging identity. */
export function releaseGitShaForRoot(root: string, releaseId: string | undefined): string {
  const gitPath = resolve(root, '.git')
  try {
    const stat = lstatSync(gitPath)
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) return ''
    const gitRoot = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (realpathSync(gitRoot) !== realpathSync(root)) return ''
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return ''
  }

  const identityPath = resolve(root, '.candidate-identity')
  try {
    const stat = lstatSync(identityPath)
    if (!stat.isFile() || stat.isSymbolicLink()) return ''
    const fields = new Map<string, string>()
    for (const line of readFileSync(identityPath, 'utf8').trim().split('\n')) {
      const separator = line.indexOf('=')
      if (separator <= 0) return ''
      const key = line.slice(0, separator)
      if (fields.has(key)) return ''
      fields.set(key, line.slice(separator + 1))
    }
    if (fields.get('release_id') !== releaseId) return ''
    if (!/^[a-f0-9]{40}$/u.test(fields.get('git_sha') ?? '')) return ''
    for (const key of ['source_sha256', 'comparison_manifest_sha256', 'sync_plan_sha256']) {
      if (!/^sha256:[a-f0-9]{64}$/u.test(fields.get(key) ?? '')) return ''
    }
    return fields.get('git_sha')!
  } catch { return '' }
}
