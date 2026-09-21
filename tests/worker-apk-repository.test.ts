import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const dockerfile = readFileSync(new URL('../infra/docker/worker.Dockerfile', import.meta.url), 'utf8')
const repositoryValidator = dockerfile.match(/node -e '([^']+)' "\$APK_REPOSITORY"/u)?.[1]

function validateRepository(value: string) {
  if (!repositoryValidator) throw new Error('worker Dockerfile repository validator is missing')
  return spawnSync(process.execPath, ['-e', repositoryValidator, value], { encoding: 'utf8' })
}

describe('worker APK repository build contract', () => {
  it('keeps the base image repositories when no override is supplied', () => {
    expect(dockerfile).toContain('ARG APK_REPOSITORY=""')
    expect(dockerfile).toContain('if [ -n "$APK_REPOSITORY" ]; then')
  })

  it('only permits an HTTPS Alpine v3.24 repository root', () => {
    expect(dockerfile).toContain('url.protocol !== "https:"')
    expect(dockerfile).toContain('url.username || url.password || url.search || url.hash')
    expect(dockerfile).toContain('path !== "/alpine/v3.24"')
    expect(dockerfile).toContain("printf '%s/main\\n%s/community\\n'")
  })

  it('executes the Dockerfile validator and rejects unsafe or incompatible repositories', () => {
    const valid = validateRepository('https://mirror.example.test/alpine/v3.24/')
    expect(valid.status).toBe(0)
    expect(valid.stdout).toBe('https://mirror.example.test/alpine/v3.24')

    for (const invalid of [
      'http://mirror.example.test/alpine/v3.24',
      'https://user:password@mirror.example.test/alpine/v3.24',
      'https://mirror.example.test/alpine/v3.24?channel=community',
      'https://mirror.example.test/alpine/v3.24#community',
      'https://mirror.example.test/alpine/v3.23',
    ]) {
      expect(validateRepository(invalid).status, invalid).not.toBe(0)
    }
  })

  it('retains APK signature verification and restores the original repositories', () => {
    expect(dockerfile).toContain('trap restore_repositories EXIT')
    expect(dockerfile).toContain('apk add --no-cache font-noto-cjk')
    expect(dockerfile).not.toContain('--allow-untrusted')
  })
})
