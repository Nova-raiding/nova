import { describe, expect, it } from 'vitest'
import { classifyAssetUpload } from './asset-upload-security.js'

// Real one-frame 16x16 black videos generated with ffmpeg, not fabricated magic
// headers. Embedded so CI does not depend on an ffmpeg installation.
// MP4: -f lavfi -i color=c=black:s=16x16:r=1 -frames:v 1 -an -c:v mpeg4
//      -flags +bitexact -fflags +bitexact -map_metadata -1 -movflags +faststart
// WebM: same lavfi input, -frames:v 1 -an -c:v libvpx-vp9 -map_metadata -1
const mp4 = Buffer.from('AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQAAAwttb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAD6AABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACWnRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAD6AAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAEAAAABAAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAA+gAAAAAAAEAAAAAAdJtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAEAAAABAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAF9bWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABPXN0YmwAAADZc3RzZAAAAAAAAAABAAAAyW1wNHYAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAEAAQAEgAAABIAAAAAAAAAAEKTGF2YyBtcGVnNAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY//8AAABPZXNkcwAAAAADgICAPgABAASAgIAwIBEAAAAAAw1AAAAAiAWAgIAeAAABsAEAAAG1iRMAAAEAAAABIADEjYgADQCEAhRjBoCAgAECAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAADDUAAAACIAAAAGHN0dHMAAAAAAAAAAQAAAAEAAEAAAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAABAAAAAQAAABRzdHN6AAAAAAAAABEAAAABAAAAFHN0Y28AAAAAAAAAAQAAAzcAAAA9dWR0YQAAADVtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAAhpbHN0AAAACGZyZWUAAAAZbWRhdAAAAbMAEAcAAAG2FgUYI9t+', 'base64')
const webm = Buffer.from('GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAH1EU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEyTbuMU6uEHFO7a1OsggHf7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjMuMS4xMDFXQYxMYXZmNjMuMS4xMDFEiYhAj0AAAAAAABZUrmvXrgEAAAAAAABO14EBc8WIYT3yctz/s1ycgQAitZyDdW5kiIEAhoVWX1ZQOYOBASPjg4Q7msoA4JCwgRC6gRCagQJVsIRVuYEBVe6BAOwBAAAAAAAAAgAAElTDZ/5zc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYzLjEuMTAxc3PZY8CLY8WIYT3yctz/s1xnyKRFo4dFTkNPREVSRIeXTGF2YzYzLjEuMTAxIGxpYnZweC12cDlnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAxLjAwMDAwMDAwMAAfQ7Z1peeBAKOggQAAgIJJg0IAAPAA9gA4JBwYSgAAMGAAABC///1IjAAcU7trkbuPs4EAt4r3gQHxggG18IED', 'base64')

const classifyVideo = (bytes: Uint8Array, format: 'mp4' | 'webm') => classifyAssetUpload({ fileName: `客户培训.${format}`, declaredMime: `video/${format}`, bytes })
const replace = (source: Buffer, from: string, to: string) => {
  const result = Buffer.from(source)
  const offset = result.indexOf(from)
  expect(offset).toBeGreaterThanOrEqual(0)
  expect(from.length).toBe(to.length)
  result.write(to, offset, 'ascii')
  return result
}

describe('video upload container identification (not malware scanning)', () => {
  it.each([['mp4', mp4], ['webm', webm]] as const)('allows a real ffmpeg-generated %s video', (format, bytes) => {
    expect(classifyVideo(bytes, format)).toMatchObject({ decision: 'allow', reasonCodes: [], audit: { signature_class: format } })
  })

  it.each([['mp4', mp4], ['webm', webm]] as const)('rejects every truncated prefix of the known-length %s sample', (format, bytes) => {
    for (let length = 0; length < bytes.length; length++) {
      expect(classifyVideo(bytes.subarray(0, length), format).decision, `prefix ${length}`).toBe('reject')
    }
  })

  it.each(['mp4', 'webm'] as const)('preserves executable and disguised-extension rejection for %s', format => {
    const bytes = Buffer.concat([Buffer.from('MZ'), format === 'mp4' ? mp4 : webm])
    expect(classifyVideo(bytes, format).reasonCodes).toContain('ASSET_EXECUTABLE_REJECTED')
    const doubleExtension = classifyAssetUpload({ fileName: `payload.exe.${format}`, declaredMime: `video/${format}`, bytes: format === 'mp4' ? mp4 : webm })
    expect(doubleExtension.reasonCodes).toContain('ASSET_DOUBLE_EXTENSION_REJECTED')
  })

  it('requires extension, declared MIME and identified container to agree', () => {
    expect(classifyVideo(webm, 'mp4').reasonCodes).toContain('ASSET_EXTENSION_SIGNATURE_MISMATCH')
    expect(classifyVideo(mp4, 'webm').reasonCodes).toContain('ASSET_MIME_SIGNATURE_MISMATCH')
    expect(classifyAssetUpload({ fileName: 'training.mp4', declaredMime: 'application/octet-stream', bytes: mp4 }).reasonCodes).toContain('ASSET_EXTENSION_MIME_MISMATCH')
    expect(classifyAssetUpload({ fileName: 'training.webm', declaredMime: ' Video/WebM; codecs="vp9" ', bytes: webm }).decision).toBe('allow')
  })

  it('does not mistake an ISO-BMFF image/audio file or bare ftyp box for MP4 video', () => {
    expect(classifyVideo(replace(mp4, 'isom', 'avif'), 'mp4').decision).toBe('reject')
    expect(classifyVideo(replace(mp4, 'vide', 'soun'), 'mp4').decision).toBe('reject')
    expect(classifyVideo(mp4.subarray(0, mp4.readUInt32BE(0)), 'mp4').decision).toBe('reject')
  })

  it('rejects malformed MP4 box sizes, incomplete child headers and appended garbage', () => {
    for (const size of [2, 15, 27, mp4.length + 1, 0xffffffff]) {
      const damaged = Buffer.from(mp4)
      damaged.writeUInt32BE(size, 0)
      expect(classifyVideo(damaged, 'mp4').decision, `ftyp size ${size}`).toBe('reject')
    }
    const damagedHandler = Buffer.from(mp4)
    damagedHandler.writeUInt32BE(12, damagedHandler.indexOf('hdlr') - 4)
    expect(classifyVideo(damagedHandler, 'mp4').decision).toBe('reject')
    const truncatedVersionOneHeader = Buffer.from(mp4)
    truncatedVersionOneHeader[truncatedVersionOneHeader.indexOf('mvhd') + 4] = 1
    expect(classifyVideo(truncatedVersionOneHeader, 'mp4').decision).toBe('reject')
    expect(classifyVideo(Buffer.concat([mp4, Buffer.from([0, 0, 0])]), 'mp4').decision).toBe('reject')
    const oversized = Buffer.from(mp4)
    oversized.writeUInt32BE(1, 0)
    oversized.writeBigUInt64BE(0xffffffffffffffffn, 8)
    expect(classifyVideo(oversized, 'mp4').decision).toBe('reject')
  })

  it('accepts bounded extended-size boxes and a final to-EOF media-data box', () => {
    const free = Buffer.from([0, 0, 0, 1, 0x66, 0x72, 0x65, 0x65, 0, 0, 0, 0, 0, 0, 0, 16])
    expect(classifyVideo(Buffer.concat([free, mp4]), 'mp4').decision).toBe('allow')
    const toEof = Buffer.from(mp4)
    toEof.writeUInt32BE(0, toEof.indexOf('mdat') - 4)
    expect(classifyVideo(toEof, 'mp4').decision).toBe('allow')
  })

  it('bounds the number of MP4 boxes to inspect', () => {
    const free = Buffer.from([0, 0, 0, 8, 0x66, 0x72, 0x65, 0x65])
    expect(classifyVideo(Buffer.concat([...Array.from({ length: 4097 }, () => free), mp4]), 'mp4').decision).toBe('reject')
  })

  it('requires a single structural WebM DocType and a real video TrackEntry', () => {
    expect(classifyVideo(replace(webm, 'webm', 'matr'), 'webm').decision).toBe('reject')
    expect(classifyVideo(replace(webm, 'V_VP9', 'A_OPU'), 'webm').decision).toBe('reject')
    const docType = Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d])
    const duplicate = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x8e]), docType, docType, webm.subarray(36)])
    expect(classifyVideo(duplicate, 'webm').decision).toBe('reject')
  })

  it('rejects invalid EBML VINTs, unknown header size and impossible advertised limits', () => {
    for (const [offset, value] of [[4, 0], [4, 0xff], [4, 0xfe], [7, 0], [19, 9], [16, 3], [20, 1]] as const) {
      const damaged = Buffer.from(webm)
      damaged[offset] = value
      expect(classifyVideo(damaged, 'webm').decision, `byte ${offset} = ${value}`).toBe('reject')
    }
    expect(classifyVideo(Buffer.concat([webm, Buffer.from([0])]), 'webm').decision).toBe('reject')
  })

  it('accepts browser-style unknown Segment and Cluster sizes without reading frame bytes as headers', () => {
    const recording = Buffer.from(webm)
    const segmentOffset = recording.indexOf(Buffer.from([0x18, 0x53, 0x80, 0x67]))
    recording.set([1, 255, 255, 255, 255, 255, 255, 255], segmentOffset + 4)
    const clusterOffset = recording.indexOf(Buffer.from([0x1f, 0x43, 0xb6, 0x75]))
    recording[clusterOffset + 4] = 0xff
    expect(classifyVideo(recording, 'webm').decision).toBe('allow')
    expect(classifyVideo(recording.subarray(0, clusterOffset + 8), 'webm').decision).toBe('reject')
  })

  it('keeps the existing asset size ceiling for videos', () => {
    const tooLarge = new Uint8Array(100 * 1024 * 1024 + 1)
    tooLarge.set(mp4)
    expect(classifyVideo(tooLarge, 'mp4').reasonCodes).toContain('ASSET_SIZE_INVALID')
  })
})
