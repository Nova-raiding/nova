import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

function gitOutput(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 })
  } catch {
    throw new Error('SCREENSHOT_MATRIX_GIT_IDENTITY_UNAVAILABLE')
  }
}

function readSourceIdentity(cwd) {
  const gitSha = gitOutput(['rev-parse', 'HEAD'], cwd).toString('utf8').trim()
  if (!/^[a-f0-9]{40,64}$/u.test(gitSha)) throw new Error('SCREENSHOT_MATRIX_GIT_IDENTITY_INVALID')

  const fields = gitOutput(['status', '--porcelain=v1', '--untracked-files=all', '-z'], cwd).toString('utf8').split('\0')
  const dirtyPaths = []
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]
    if (!field) continue
    // Porcelain v1 -z starts each entry with the two-character status and a
    // space. Keep only paths; never request or serialize diff contents.
    const status = field.slice(0, 2)
    const path = field.slice(3)
    if (path) dirtyPaths.push(path)
    if (status.includes('R') || status.includes('C')) {
      const previousPath = fields[++index]
      if (previousPath) dirtyPaths.push(previousPath)
    }
  }
  const uniqueDirtyPaths = [...new Set(dirtyPaths)].sort()
  return { gitSha, clean: uniqueDirtyPaths.length === 0, dirtyPaths: uniqueDirtyPaths }
}

function sourceSnapshot(identity) {
  return { status: identity.clean ? 'clean' : 'dirty', dirtyPaths: identity.dirtyPaths }
}

export async function createScreenshotMatrixEvidence({ evidenceDir, matrixName, cwd = process.cwd(), now = () => new Date() }) {
  const root = resolve(evidenceDir)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const captureStartIdentity = readSourceIdentity(cwd)
  const manifestPath = resolve(root, 'screenshot-capture-manifest.json')
  const manifest = {
    schemaVersion: 1,
    matrixName,
    generatedAt: now().toISOString(),
    source: {
      gitSha: captureStartIdentity.gitSha,
      captureStart: sourceSnapshot(captureStartIdentity),
      captureEnd: null,
      exactCleanShaClaimable: false,
      claimStatus: captureStartIdentity.clean ? 'pending_capture_end_check' : 'dirty_source_no_exact_clean_sha_claim',
    },
    captures: [],
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' })

  async function persist() {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  }

  return {
    manifestPath,
    async capture(page, { filePath, label, fullPage = true }) {
      const absolutePath = resolve(filePath)
      const pathFromRoot = relative(root, absolutePath)
      if (!pathFromRoot || pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || pathFromRoot.startsWith(sep)) {
        throw new Error('SCREENSHOT_MATRIX_CAPTURE_PATH_OUTSIDE_EVIDENCE_ROOT')
      }
      const viewport = page.viewportSize()
      const capturedAt = now().toISOString()
      await page.screenshot({ path: absolutePath, fullPage })
      manifest.captures.push({
        label,
        file: pathFromRoot.split(sep).join('/'),
        route: new URL(page.url()).pathname,
        viewport: viewport ? { width: viewport.width, height: viewport.height } : null,
        fullPage,
        capturedAt,
      })
      await persist()
    },
    async finalize() {
      const captureEndIdentity = readSourceIdentity(cwd)
      const unchangedSha = captureStartIdentity.gitSha === captureEndIdentity.gitSha
      const cleanAtBothEnds = captureStartIdentity.clean && captureEndIdentity.clean
      manifest.source.captureEnd = sourceSnapshot(captureEndIdentity)
      manifest.source.exactCleanShaClaimable = unchangedSha && cleanAtBothEnds
      manifest.source.claimStatus = manifest.source.exactCleanShaClaimable
        ? 'exact_clean_git_sha'
        : 'dirty_or_changed_source_no_exact_clean_sha_claim'
      manifest.completedAt = now().toISOString()
      await persist()
      return manifest
    },
  }
}
