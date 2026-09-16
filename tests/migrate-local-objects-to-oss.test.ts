import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = 'scripts/migrate-local-objects-to-oss.py'

function runWithSource(source: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('python3', [script, ...args], {
    env: {
      ...process.env,
      LOCAL_OBJECT_ROOT: source,
      ASSET_STORAGE_BUCKET: 'merchant-assets',
      ASSET_STORAGE_REGION: 'cn-beijing',
      ASSET_STORAGE_ENDPOINT: 'https://s3.oss-cn-beijing.aliyuncs.com',
      ...env,
    },
    encoding: 'utf8',
  })
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'oss-migration-recovery-'))
  const objects = join(root, 'objects'); const remote = join(root, 'remote'); const bin = join(root, 'bin')
  mkdirSync(objects); mkdirSync(remote); mkdirSync(bin)
  const payload = 'recoverable-body'
  writeFileSync(join(objects, 'asset'), payload)
  const meta = { key: 'asset', sha256: '3a185052913327f8af416eb3091e8589ea8ce1ba47757f2e70d9416b44526b08', sizeBytes: payload.length, contentType: 'text/plain', workspaceId: 'ws_test', zone: 'original' }
  writeFileSync(join(objects, 'asset.meta.json'), JSON.stringify(meta))
  const fake = join(bin, 'ossutil')
  writeFileSync(fake, `#!/usr/bin/env node
const fs=require('fs'), path=require('path'); const a=process.argv.slice(2); const root=process.env.FAKE_OSS_ROOT;
const value=(flag)=>a[a.indexOf(flag)+1];
if(a[0]==='api'&&a[1]==='head-object'){const p=path.join(root,value('--key')); process.exit(fs.existsSync(p)?0:(console.error('404 NoSuchKey'),1));}
if(a[0]==='api'&&a[1]==='put-object'){const p=path.join(root,value('--key')); if(fs.existsSync(p)) process.exit(2); fs.mkdirSync(path.dirname(p),{recursive:true}); fs.copyFileSync(value('--body').slice(7),p); process.exit(0);}
if(a[0]==='cp'){const key=a[1].replace(/^oss:\\/\\/[^/]+\\//,''); const p=path.join(root,key); if(!fs.existsSync(p)) process.exit(3); fs.copyFileSync(p,a[2]); process.exit(0);}
process.exit(4);`)
  chmodSync(fake, 0o755)
  return { objects, remote, meta, env: { FAKE_OSS_ROOT: remote, PATH: `${bin}:${process.env.PATH}` } }
}

describe('local object to OSS migration source boundary', () => {
  it('rejects a symlinked object body before invoking ossutil', () => {
    const root = mkdtempSync(join(tmpdir(), 'oss-migration-source-'))
    const objects = join(root, 'objects')
    mkdirSync(objects)
    const outside = join(root, 'outside-secret')
    writeFileSync(outside, 'must-not-be-uploaded')
    symlinkSync(outside, join(objects, 'asset'))
    writeFileSync(join(objects, 'asset.meta.json'), JSON.stringify({
      key: 'asset',
      sha256: 'unused',
      sizeBytes: 20,
      contentType: 'text/plain',
      workspaceId: 'ws_test',
      zone: 'original',
    }))

    const result = runWithSource(objects)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('LOCAL_OBJECT_FILE_INVALID')
    expect(result.stderr).not.toContain('must-not-be-uploaded')
  })

  it('recovers a matching body-only partial upload and is idempotent after completion', () => {
    const f = fixture()
    const remoteBody = join(f.remote, 'merchant-assets', 'asset')
    mkdirSync(join(f.remote, 'merchant-assets'), { recursive: true })
    writeFileSync(remoteBody, readFileSync(join(f.objects, 'asset')))

    const recovery = runWithSource(f.objects, ['--apply'], f.env)
    expect(recovery.status, recovery.stderr).toBe(0)
    expect(JSON.parse(recovery.stdout)).toMatchObject({ objects_verified: 1, objects_copied: 1 })
    expect(JSON.parse(readFileSync(`${remoteBody}.merchant-meta.json`, 'utf8'))).toEqual(f.meta)

    const retry = runWithSource(f.objects, ['--apply'], f.env)
    expect(retry.status, retry.stderr).toBe(0)
    expect(JSON.parse(retry.stdout)).toMatchObject({ objects_verified: 1, objects_copied: 0 })
  })

  it('does not resume when the pre-existing remote body differs', () => {
    const f = fixture()
    const remoteBody = join(f.remote, 'merchant-assets', 'asset')
    mkdirSync(join(f.remote, 'merchant-assets'), { recursive: true })
    writeFileSync(remoteBody, 'different-body')

    const result = runWithSource(f.objects, ['--apply'], f.env)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('OSS_EXISTING_BODY_MISMATCH')
    expect(() => readFileSync(`${remoteBody}.merchant-meta.json`)).toThrow()
  })
})
