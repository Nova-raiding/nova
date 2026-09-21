import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const dockerfile = readFileSync(new URL('../infra/docker/worker.Dockerfile', import.meta.url), 'utf8')

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

  it('retains APK signature verification and restores the original repositories', () => {
    expect(dockerfile).toContain('trap restore_repositories EXIT')
    expect(dockerfile).toContain('apk add --no-cache font-noto-cjk')
    expect(dockerfile).not.toContain('--allow-untrusted')
  })
})
