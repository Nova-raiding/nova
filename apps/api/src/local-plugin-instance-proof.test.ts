import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { localPluginInstanceProofMessage, p256SpkiFingerprint, verifyLocalPluginInstanceProof, type LocalPluginInstanceProofTranscript } from './local-plugin-instance-proof.js'

const transcript = (platform: 'macos'|'windows'): LocalPluginInstanceProofTranscript => ({ method:'POST',path:'/v1/auth/local-plugin/authorize',apiOrigin:'https://yxsona.com',requestId:'11111111-1111-4111-8111-111111111111',challengeId:'22222222-2222-4222-8222-222222222222',accountId:'33333333-3333-4333-8333-333333333333',workspaceId:'ws_demo',installationId:'44444444-4444-4444-8444-444444444444',keyId:'p256:1',platform,pkceChallenge:randomBytes(32).toString('base64url'),redirectUri:'http://127.0.0.1:4567/merchant-mcp-callback',clientNonce:randomBytes(32).toString('base64url'),serverNonce:randomBytes(32).toString('base64url'),issuedAt:'2026-09-22T00:00:00.000Z',expiresAt:'2026-09-22T00:02:00.000Z' })

describe.each(['macos','windows'] as const)('P-256 installation proof on %s', platform => {
  it('binds the full transcript and rejects cross-platform replay', () => {
    const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}), input=transcript(platform)
    const publicKeySpki=(pair.publicKey.export({format:'der',type:'spki'}) as Buffer).toString('base64url')
    const signature=sign('sha256',localPluginInstanceProofMessage(input),pair.privateKey).toString('base64url')
    expect(p256SpkiFingerprint(publicKeySpki)).toHaveLength(43)
    expect(verifyLocalPluginInstanceProof({...input,publicKeySpki,signature})).toBe(true)
    expect(verifyLocalPluginInstanceProof({...input,platform:platform==='macos'?'windows':'macos',publicKeySpki,signature})).toBe(false)
    expect(verifyLocalPluginInstanceProof({...input,workspaceId:'ws_other',publicKeySpki,signature})).toBe(false)
  })
})
