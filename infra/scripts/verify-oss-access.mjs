import Credential, { Config } from '@alicloud/credentials'
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'

function block(reason) {
  console.error(`OSS preflight blocked: ${reason}`)
  process.exit(2)
}

const required = ['ASSET_STORAGE_BUCKET', 'ASSET_STORAGE_REGION', 'ASSET_STORAGE_ENDPOINT']
const missing = required.filter(key => !process.env[key]?.trim())
if (missing.length) block(`missing ${missing.join(', ')}`)

let endpoint
try { endpoint = new URL(process.env.ASSET_STORAGE_ENDPOINT.trim()) }
catch { block('ASSET_STORAGE_ENDPOINT must be a valid HTTPS URL') }
if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) block('ASSET_STORAGE_ENDPOINT must be a credential-free HTTPS URL')

const provider = process.env.ASSET_STORAGE_CREDENTIAL_PROVIDER?.trim() || 'static'
let credentials
if (provider === 'aliyun_ecs_ram_role') {
  const roleName = process.env.ASSET_STORAGE_ECS_RAM_ROLE?.trim()
  if (!roleName || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(roleName)) block('ASSET_STORAGE_ECS_RAM_ROLE is required and must be valid')
  if (['OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'].some(key => process.env[key]?.trim())) block('ECS RAM Role preflight must not receive static object-storage credentials')
  const roleClient = new Credential.default(new Config({ type: 'ecs_ram_role', roleName, disableIMDSv1: true, asyncCredentialUpdateEnabled: true, connectTimeout: 1_000, timeout: 2_000 }))
  credentials = async () => {
    const value = await roleClient.getCredential()
    const accessKeyId = value.accessKeyId?.trim()
    const secretAccessKey = value.accessKeySecret?.trim()
    const sessionToken = value.securityToken?.trim()
    if (!accessKeyId || !secretAccessKey || !sessionToken) throw new Error('ALIYUN_ECS_RAM_ROLE_CREDENTIALS_INVALID')
    return { accessKeyId, secretAccessKey, sessionToken }
  }
} else if (provider === 'static') {
  if (process.env.NODE_ENV === 'production') block('production preflight requires aliyun_ecs_ram_role')
  const accessKeyId = (process.env.OSS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID)?.trim()
  const secretAccessKey = (process.env.OSS_ACCESS_KEY_SECRET || process.env.AWS_SECRET_ACCESS_KEY)?.trim()
  if (!accessKeyId || !secretAccessKey) block('missing static OSS credentials')
  credentials = { accessKeyId, secretAccessKey }
} else block('unsupported ASSET_STORAGE_CREDENTIAL_PROVIDER')
const client = new S3Client({
  region: process.env.ASSET_STORAGE_REGION.trim(),
  endpoint: endpoint.toString(),
  forcePathStyle: process.env.ASSET_STORAGE_FORCE_PATH_STYLE === 'true',
  credentials,
})

try {
  await client.send(new ListObjectsV2Command({
    Bucket: process.env.ASSET_STORAGE_BUCKET.trim(),
    Prefix: process.env.ASSET_STORAGE_PREFIX?.trim() || 'merchant-assets',
    MaxKeys: 1,
  }))
  console.log(`OSS preflight passed: authenticated bucket read succeeded (${provider})`)
} catch (error) {
  const name = error instanceof Error ? error.name : ''
  const category = /^(?:AccessDenied|Forbidden|InvalidAccessKeyId|SignatureDoesNotMatch|NoSuchBucket|TimeoutError|CredentialsProviderError)$/u.test(name) ? name : 'OSS_READ_FAILED'
  console.error(`OSS preflight failed: ${category}`)
  process.exit(1)
}
