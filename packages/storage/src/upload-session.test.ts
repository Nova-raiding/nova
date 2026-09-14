import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MAX_UPLOAD_BYTES, UploadSessionManager, MemoryUploadSessionTransport } from './upload-session.js'
describe('upload sessions',()=>{it('validates size and digest without base64',async()=>{const body=Buffer.from('abc'); const m=new UploadSessionManager(new MemoryUploadSessionTransport()); const s=m.create({workspaceId:'w',fileName:'x',contentType:'text/plain',sizeBytes:3,sha256:createHash('sha256').update(body).digest('hex')}); m.putPart(s.id,1,body); expect((await m.complete(s.id)).objectKey).toContain('quarantine/w/uploads/'); expect(()=>m.create({workspaceId:'w',fileName:'x',contentType:'x',sizeBytes:MAX_UPLOAD_BYTES+1,sha256:'a'.repeat(64)})).toThrow('UPLOAD_SIZE_LIMIT_EXCEEDED')})})
