import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export const MAX_RUNTIME_EVIDENCE_BYTES = 1024 * 1024

/** Read only a bounded regular file without following a final-component symlink
 * or blocking on a FIFO/device. The inode and size are checked around the read
 * so runtime diagnostics fail closed if the configured file changes in place. */
export function readSafeRuntimeEvidenceFile(path: string): string {
  if (!isAbsolute(path)) throw new Error('evidence path must be absolute')
  const beforePath = lstatSync(path, { bigint: true })
  if (!beforePath.isFile()) throw new Error('evidence path is not a regular file')

  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd, { bigint: true })
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(MAX_RUNTIME_EVIDENCE_BYTES)) {
      throw new Error('evidence file size or type is invalid')
    }
    if (before.dev !== beforePath.dev || before.ino !== beforePath.ino) throw new Error('evidence file changed while opening')

    const chunks: Buffer[] = []
    const chunk = Buffer.allocUnsafe(64 * 1024)
    let bytesRead = 0
    while (true) {
      const count = readSync(fd, chunk, 0, chunk.byteLength, null)
      if (count === 0) break
      bytesRead += count
      if (bytesRead > MAX_RUNTIME_EVIDENCE_BYTES) throw new Error('evidence file exceeds the runtime size limit')
      chunks.push(Buffer.from(chunk.subarray(0, count)))
    }

    const after = fstatSync(fd, { bigint: true })
    const afterPath = lstatSync(path, { bigint: true })
    if (!after.isFile() || !afterPath.isFile()
      || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || BigInt(bytesRead) !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || after.dev !== afterPath.dev || after.ino !== afterPath.ino) {
      throw new Error('evidence file changed while reading')
    }
    return Buffer.concat(chunks, bytesRead).toString('utf8')
  } finally {
    closeSync(fd)
  }
}
