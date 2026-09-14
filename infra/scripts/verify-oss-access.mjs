import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'

const required = ['ASSET_STORAGE_BUCKET', 'ASSET_STORAGE_REGION', 'ASSET_STORAGE_ENDPOINT']
const missing = required.filter(key => !process.env[key]?.trim())
if (!process.env.OSS_ACCESS_KEY_ID?.trim() && !process.env.AWS_ACCESS_KEY_ID?.trim()) missing.push('OSS_ACCESS_KEY_ID')
if (!process.env.OSS_ACCESS_KEY_SECRET?.trim() && !process.env.AWS_SECRET_ACCESS_KEY?.trim()) missing.push('OSS_ACCESS_KEY_SECRET')
if (missing.length) {
  console.error(`OSS preflight blocked: missing ${missing.join(', ')}`)
  process.exit(2)
}

const endpoint = process.env.ASSET_STORAGE_ENDPOINT.trim()
if (new URL(endpoint).protocol !== 'https:') {
  console.error('OSS preflight blocked: ASSET_STORAGE_ENDPOINT must use HTTPS')
  process.exit(2)
}

const credentials = {
  accessKeyId: (process.env.OSS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID).trim(),
  secretAccessKey: (process.env.OSS_ACCESS_KEY_SECRET || process.env.AWS_SECRET_ACCESS_KEY).trim(),
}
const client = new S3Client({
  region: process.env.ASSET_STORAGE_REGION.trim(),
  endpoint,
  forcePathStyle: process.env.ASSET_STORAGE_FORCE_PATH_STYLE === 'true',
  credentials,
})

try {
  await client.send(new ListObjectsV2Command({
    Bucket: process.env.ASSET_STORAGE_BUCKET.trim(),
    Prefix: process.env.ASSET_STORAGE_PREFIX?.trim() || 'merchant-assets',
    MaxKeys: 1,
  }))
  console.log('OSS preflight passed: authenticated bucket read succeeded')
} catch (error) {
  const code = error && typeof error === 'object' && 'name' in error ? String(error.name) : 'unknown_error'
  console.error(`OSS preflight failed: ${code}`)
  process.exit(1)
}
