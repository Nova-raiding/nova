import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const provenanceFile = 'bundle-provenance.json'
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')

function inventory(root, directory = '') {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap(entry => {
    const path = directory ? `${directory}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error(`bundle contains a symlink: ${path}`)
    if (entry.isDirectory()) return inventory(root, path)
    if (!entry.isFile()) throw new Error(`bundle contains a special file: ${path}`)
    return path === provenanceFile ? [] : [path]
  }).sort()
}

export function writeBundleProvenance(root, { plugin, version, platform, architecture, gitCommit, sourceDirty }) {
  if (!/^[0-9a-f]{40}$/u.test(gitCommit)) throw new Error('bundle source Git commit is invalid')
  const files = inventory(root).map(path => ({ path, sha256: sha256(resolve(root, path)) }))
  const record = { schema_version: '1', plugin, version, platform, architecture,
    git_commit: gitCommit, source_dirty: sourceDirty, authenticity_verified: false,
    files }
  writeFileSync(resolve(root, provenanceFile), `${JSON.stringify(record, null, 2)}\n`)
  return record
}

export function verifyBundleProvenance(root, { installed = false } = {}) {
  const errors = []
  let record
  try { record = JSON.parse(readFileSync(resolve(root, provenanceFile), 'utf8')) }
  catch { return { ok: false, errors: ['bundle provenance is missing or invalid'] } }
  if (record?.schema_version !== '1' || record.plugin !== 'merchant-marketing' ||
      !/^[0-9a-f]{40}$/u.test(record.git_commit ?? '') ||
      typeof record.source_dirty !== 'boolean' || record.authenticity_verified !== false ||
      !['darwin', 'win32'].includes(record.platform) || !['arm64', 'x64'].includes(record.architecture) ||
      record.platform !== process.platform || record.architecture !== process.arch) errors.push('bundle provenance identity is invalid')
  let manifest
  try { manifest = JSON.parse(readFileSync(resolve(root, '.codex-plugin/plugin.json'), 'utf8')) }
  catch { errors.push('plugin manifest is missing or invalid') }
  if (record.plugin !== manifest?.id) errors.push('bundle provenance plugin does not match plugin manifest')
  if (record.version !== manifest?.version) errors.push('bundle provenance version does not match plugin manifest')
  try {
    const status = JSON.parse(readFileSync(resolve(root, 'bundle-status.json'), 'utf8'))
    if (status.source_dirty !== record.source_dirty ||
        ((record.source_dirty || status.ci_test_certificate === true) && status.ready_to_install !== false)) {
      errors.push('bundle status conflicts with provenance or deliverability')
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') errors.push('bundle status is invalid')
  }
  if (!Array.isArray(record.files) || !record.files.length) errors.push('bundle provenance file list is invalid')
  else {
    const expected = record.files.filter(file => !(installed && typeof file?.path === 'string' && file.path.startsWith('.agents/')))
    const paths = expected.map(file => file?.path)
    const invalidPaths = paths.some((path, index) => typeof path !== 'string' || !path || path.startsWith('/') ||
        path.includes('\\') || path.split('/').some(segment => segment === '.' || segment === '..' || !segment) ||
        (index > 0 && paths[index - 1] >= path))
    if (invalidPaths) errors.push('bundle provenance file paths are invalid or unsorted')
    const actual = inventory(root)
    const checked = installed ? actual.filter(path => !path.startsWith('.agents/')) : actual
    if (JSON.stringify(paths) !== JSON.stringify(checked)) errors.push('bundle provenance file inventory differs')
    for (const file of invalidPaths ? [] : expected) {
      if (!/^[0-9a-f]{64}$/u.test(file.sha256 ?? '')) { errors.push(`invalid file digest: ${file.path}`); continue }
      try {
        const path = resolve(root, file.path)
        if (!lstatSync(path).isFile() || sha256(path) !== file.sha256) errors.push(`file digest differs: ${file.path}`)
      } catch { errors.push(`file missing: ${file.path}`) }
    }
  }
  return { ok: errors.length === 0, errors, git_commit: record.git_commit,
    source_dirty: record.source_dirty, version: record.version, platform: record.platform,
    architecture: record.architecture, authenticity_verified: false, checked_files: record.files?.length ?? 0 }
}
