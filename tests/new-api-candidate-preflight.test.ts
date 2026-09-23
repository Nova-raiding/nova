import { describe, expect, it } from 'vitest'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectNewApiSession, validateCandidateKeyReadback, validateNewApiCandidatePreflight } from '../scripts/new-api-candidate-preflight.js'

const now = new Date('2026-09-23T08:00:00.000Z')
const keyExpectation = { id: 17, models: ['text-model', 'image-model'], maxRemainingQuota: 1000, maxExpirySeconds: Math.floor(now.getTime() / 1000) + 3600 }
const keyResponse = { success: true, data: { id: 17, key: 'sk-top-secret', status: 1, unlimited_quota: false, model_limits_enabled: true, model_limits: 'text-model,image-model', remain_quota: 500, expired_time: Math.floor(now.getTime() / 1000) + 1800 } }
const videoExpectation = { id: 18, models: ['video-model'], maxRemainingQuota: 1000, maxExpirySeconds: Math.floor(now.getTime() / 1000) + 3600 }
const videoResponse = { success: true, data: { id: 18, key: 'sk-video-secret', status: 1, unlimited_quota: false, model_limits_enabled: true, model_limits: 'video-model', remain_quota: 500, expired_time: Math.floor(now.getTime() / 1000) + 1800 } }

describe('New API candidate read-only preflight', () => {
  it('inspects only safe session metadata and never returns credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'new-api-preflight-'))
    const sessionFile = join(directory, 'session.json')
    try {
      await writeFile(sessionFile, JSON.stringify({ userId: '42', userToken: 'sensitive-access', refreshCookie: 'new_api_refresh=sensitive-cookie' }), { mode: 0o600 })
      const report = await inspectNewApiSession(sessionFile, '42')
      expect(report).toMatchObject({ directory_mode: 0o700, session_mode: 0o600, user_id_matches: true, has_access_token: true, has_refresh_cookie: true })
      expect(JSON.stringify(report)).not.toMatch(/sensitive|new_api_refresh|\b42\b/u)
      await chmod(directory, 0o755)
      await expect(inspectNewApiSession(sessionFile, '42')).rejects.toThrow('NEW_API_PREFLIGHT_DIRECTORY_UNSAFE')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('requires exact finite enabled model-limited candidate key readback', () => {
    expect(validateCandidateKeyReadback(keyResponse, keyExpectation, Math.floor(now.getTime() / 1000))).toEqual([])
    const invalid = { success: true, data: { ...keyResponse.data, unlimited_quota: true, model_limits_enabled: false, model_limits: 'other', expired_time: -1 } }
    const errors = validateCandidateKeyReadback(invalid, keyExpectation, Math.floor(now.getTime() / 1000))
    expect(errors).toHaveLength(4)
    expect(JSON.stringify(errors)).not.toContain('sk-top-secret')
  })

  it('blocks absent management login and rejects replicas that do not share the same directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'new-api-preflight-'))
    const sessionFile = join(directory, 'session.json')
    try {
      await writeFile(sessionFile, JSON.stringify({ userId: '42', userToken: 'access', refreshCookie: 'new_api_refresh=cookie' }), { mode: 0o600 })
      const report = await inspectNewApiSession(sessionFile, '42')
      const secondReport = { ...report, replica_id: `${report.replica_id}-second` }
      const bundle = {
        expectedUserId: '42', expectedOrigin: 'https://relay.example.test',
        expectedModelByModality: { text: 'text-model', image: 'image-model', image_edit: 'image-model', ocr: 'text-model', video: 'video-model' },
        sessionReports: [report, secondReport],
        keys: [{ expected: keyExpectation, readback: keyResponse }, { expected: videoExpectation, readback: videoResponse }],
      }
      expect(validateNewApiCandidatePreflight(bundle, now)).toContain('authenticated management self readback is missing, stale or mismatched')
      const managementSelf = { httpStatus: 200, observedAt: now.toISOString(), origin: 'https://relay.example.test', response: { success: true, data: { id: 42 } } }
      expect(validateNewApiCandidatePreflight({ ...bundle, managementSelf }, now)).toEqual([])
      const otherReplica = { ...secondReport, directory_ino: report.directory_ino + 1 }
      expect(validateNewApiCandidatePreflight({ ...bundle, managementSelf, sessionReports: [report, otherReplica] }, now)).toContain('replica session path, owner, permission or shared directory identity differs')
      expect(validateNewApiCandidatePreflight({ ...bundle, managementSelf, sessionReports: [report, report] }, now)).toContain('replica reports must identify distinct containers')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
